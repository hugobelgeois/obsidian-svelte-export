import { App, Notice, TFile } from "obsidian";
import * as path from "path";
import {
	IMAGE_EXTENSIONS,
	isNote,
	isWithinAny,
	routeOf,
	staticFilePath,
} from "./constants";
import { openInFileExplorer } from "./electronDialog";
import { ExportProgressModal } from "./exportModal";
import {
	ExportState,
	isUpToDate,
	loadExportState,
	recordExported,
	recordPage,
	recordRuntimeCss,
	saveExportState,
} from "./exportState";
import {
	captureBodyAppearanceCss,
	captureObsidianBaseCss,
	captureStyleSettingsCss,
	readActiveCss,
} from "./obsidianCss";
import {
	errorMessage,
	getVaultBasePath,
	resolveDestinationPath,
} from "./obsidianUtil";
import { readLayouts, STATBLOCKS_PLUGIN_ID } from "./liveStatblocks";
import { NoteRenderer } from "./noteRenderer";
import { exportFile, isNotePage, pageFiles, SiteInfo } from "./pageexporter";
import { pluginDir } from "./pluginIntegrations";
import { publishedParts } from "./publishedParts";
import { ensureSvelteProject } from "./scaffold";
import type { SvelteExporterSettings } from "./settings";
import {
	defaultPageFiles,
	listedNotes,
	patchAppHtml,
	writeCustomScripts,
	writeSearchIndex,
	writeSiteData,
	writeSitemap,
} from "./siteFiles";
import { SyncedFolder } from "./syncedFolder";

/** Where one export reads from and writes to. */
export interface ExportContext {
	app: App;
	settings: SvelteExporterSettings;
	vaultPath: string;
	/** Root of the exported SvelteKit project. */
	destinationPath: string;
	/** Its src/lib/ — data files the site reads at build time. */
	libDir: string;
	/** Its src/routes/ — one folder per exported note. */
	routesDir: string;
	/** The vault's config folder (.obsidian/), absolute. */
	obsidianDir: string;
	/** This plugin's own folder (holds svelte-lib/). */
	pluginDir: string;
}

/** Notes rendered at once — each waits for Obsidian's asynchronous
 * rendering (plugins, embeds) to settle, so they overlap well. */
const RENDER_CONCURRENCY = 6;

interface ExportCounts {
	exported: number;
	skipped: number;
	errors: number;
}

/** One export of `files` into the destination set in the settings. */
export class SiteExporter {
	private readonly ctx: ExportContext;

	constructor(
		app: App,
		settings: SvelteExporterSettings,
		pluginDir: string,
		private readonly files: TFile[],
		private readonly progressModal: ExportProgressModal,
	) {
		const vaultPath = getVaultBasePath(app);
		const destinationPath = resolveDestinationPath(
			vaultPath,
			settings.destinationPath,
		);
		this.ctx = {
			app,
			settings,
			vaultPath,
			destinationPath,
			libDir: path.join(destinationPath, "src", "lib"),
			routesDir: path.join(destinationPath, "src", "routes"),
			obsidianDir: path.join(vaultPath, app.vault.configDir),
			pluginDir,
		};
	}

	async run(): Promise<void> {
		const { ctx, files, progressModal } = this;

		// Obsidian's own base CSS + appearance settings, read from this very
		// window — what makes an exported theme look like it does in Obsidian.
		const obsidianCss = {
			base: await captureObsidianBaseCss(),
			appearance: captureBodyAppearanceCss(),
			styleSettings: captureStyleSettingsCss(),
		};

		const activeCss = readActiveCss(
			ctx.obsidianDir,
			ctx.settings.selectedTheme,
		);

		// What of each note gets a page (see publishedParts.ts) — the single
		// source of truth for "which routes should exist right now", reused
		// to pick the default page and resolve links. A hidden note nothing
		// links to gets none: it's left out of everything the site is made
		// of, so its old page is pruned. So is a hidden image, unless a
		// published page shows it (then it's copied as that page's asset).
		const hidden = new Set(ctx.settings.hiddenPaths);
		const parts = publishedParts(ctx.app, files, ctx.settings.hiddenPaths);
		const siteFiles = files.filter((f) =>
			isNote(f) ? parts.has(f.path) : !isWithinAny(f.path, hidden),
		);
		const expectedRoutes = new Set([...parts.keys()].map(routeOf));

		const ready = await ensureSvelteProject(
			ctx,
			activeCss,
			obsidianCss,
			defaultPageFiles(ctx.settings.defaultPage, expectedRoutes),
			(status) => progressModal.setPreparing(status),
		);
		if (!ready) {
			progressModal.close();
			return;
		}

		const staticFiles = new SyncedFolder(
			path.join(ctx.destinationPath, "static"),
		);
		// Tells GitHub Pages to skip Jekyll processing, which otherwise
		// silently drops any file/folder starting with an underscore —
		// including SvelteKit's own _app/ build output.
		staticFiles.write(".nojekyll", "");
		// The notes' pages — every one is written or kept below, so a note
		// deleted (or deselected) from the vault loses its page in prune().
		const pages = new SyncedFolder(ctx.routesDir);

		writeCustomScripts(ctx);
		const styleSettingsClasses = writeSiteData(
			ctx,
			siteFiles,
			activeCss,
			obsidianCss.styleSettings,
		);
		patchAppHtml(ctx, staticFiles, styleSettingsClasses);

		const site = this.siteInfo();
		const state = loadExportState(ctx, siteFiles, parts, site);
		const counts = await this.exportFiles(siteFiles, staticFiles, pages, state);
		// Hidden notes nothing publishes count as skipped.
		counts.skipped += files.length - siteFiles.length;
		saveExportState(ctx, staticFiles, state);
		const listed = listedNotes(siteFiles, ctx.settings.hiddenPaths);
		writeSearchIndex(staticFiles, listed, state.pageState.pages);
		writeSitemap(staticFiles, listed, site);
		// Last, once everything the site needs has been copied/written —
		// an export that failed before this point deletes nothing.
		staticFiles.prune();
		pages.prune(isNotePage);

		await this.report(counts);
	}

	/** The per-file export loop: images are copied, notes rendered (unless
	 * up to date). Updates `state` as it goes. */
	private async exportFiles(
		files: TFile[],
		staticFiles: SyncedFolder,
		pages: SyncedFolder,
		state: ExportState,
	): Promise<ExportCounts> {
		const { app, vaultPath } = this.ctx;
		const counts: ExportCounts = { exported: 0, skipped: 0, errors: 0 };
		const renderer = new NoteRenderer(
			app,
			vaultPath,
			state.active,
			state.publishedNotes,
			readLayouts(
				pluginDir(app, vaultPath, { pluginId: STATBLOCKS_PLUGIN_ID }),
			),
			(note) => state.parts.get(note.path) === "all",
		);

		// The progress bar counts every selected file — those left out of
		// the site (unpublished hidden notes) are done already.
		let processed = this.files.length - files.length;
		const exportOne = async (file: TFile) => {
			this.progressModal.update(++processed, file.path);
			try {
				const mtime = file.stat.mtime;
				if (IMAGE_EXTENSIONS.has(file.extension)) {
					// Always recorded (copied only if changed), or prune()
					// would delete it — under its vault path, where note
					// pages point to it (see staticFilePath).
					staticFiles.copy(
						path.join(vaultPath, file.path),
						staticFilePath(file.path),
					);
				} else {
					// The page from a previous export stays, unless rewritten
					// below — a cache-skipped note's, or one that fails now.
					for (const rel of pageFiles(file.path)) pages.keep(rel);
					// The cache only skips the (expensive) rendering.
					if (isUpToDate(state, file)) {
						counts.skipped++;
						return;
					}
					const result = await exportFile(
						file,
						state.parts.get(file.path) ?? "all",
						pages,
						app,
						renderer,
						state.site,
					);
					recordPage(this.ctx, state, file, result);
				}
				recordExported(state, file, mtime);
				counts.exported++;
			} catch (e) {
				console.error(
					`[SvelteExporter] Failed to export ${file.path}:`,
					e,
				);
				counts.errors++;
			}
		};

		try {
			// A shared cursor rather than queue.shift(), which is O(n) each.
			let next = 0;
			await Promise.all(
				Array.from({ length: RENDER_CONCURRENCY }, async () => {
					for (let file; (file = files[next++]); ) await exportOne(file);
				}),
			);
		} finally {
			renderer.dispose();
		}
		recordRuntimeCss(state, renderer.runtimeCss);
		return counts;
	}

	private async report({ exported, skipped, errors }: ExportCounts) {
		const parts: string[] = [];
		if (exported) parts.push(`✅ ${exported} exported`);
		if (skipped) parts.push(`⏭ ${skipped} skipped (up-to-date)`);
		if (errors) parts.push(`❌ ${errors} error(s)`);
		const summary = parts.join(" · ");

		this.progressModal.finish(summary);
		setTimeout(() => this.progressModal.close(), 1200);

		new Notice(summary);

		if (this.ctx.settings.openAfterExport) {
			try {
				await openInFileExplorer(this.ctx.destinationPath);
			} catch (e) {
				new Notice(
					`⚠️ could not open destination folder: ${errorMessage(e)}`,
				);
				console.error(
					"[SvelteExporter] Could not open destination folder:",
					e,
				);
			}
		}
	}

	/** Site-wide details baked into every page (see SiteInfo). */
	private siteInfo(): SiteInfo {
		return {
			url: this.ctx.settings.siteUrl.trim().replace(/\/+$/, ""),
			name: this.ctx.app.vault.getName(),
		};
	}
}
