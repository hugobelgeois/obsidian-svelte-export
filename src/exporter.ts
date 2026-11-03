import { App, Notice, TFile } from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS, routeOf, staticFilePath } from "./constants";
import { openInFileExplorer } from "./electronDialog";
import { ExportProgressModal } from "./exportModal";
import {
	captureBodyAppearanceCss,
	captureObsidianBaseCss,
	captureStyleSettingsCss,
	readActiveCss,
} from "./obsidianCss";
import {
	EXPORT_CACHE_FILE,
	getVaultBasePath,
	readJsonFile,
	resolveDestinationPath,
	writeJsonFile,
} from "./obsidianUtil";
import {
	assetStaticPath,
	dependencyKey,
	NoteDeps,
	NoteRenderer,
} from "./noteRenderer";
import {
	exportFile,
	isNotePage,
	PAGE_FORMAT_VERSION,
	pageFiles,
	SiteInfo,
} from "./pageexporter";
import {
	activeIntegrations,
	buildIntegrationCss,
	integrationSignature,
	PLUGIN_INTEGRATIONS,
	PluginIntegration,
} from "./pluginIntegrations";
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

type ExportCache = Record<string, number>;
type LinksMap = Record<string, string[]>;

/**
 * .export-plugins.json — what the mtime cache alone can't tell: which
 * pages contain plugin blocks (to re-export them when that plugin's
 * settings change), which local files those blocks reference (static/ keeps
 * only what each export records, so they're recorded even for cache-skipped
 * pages), and the runtime CSS captured while rendering them.
 */
interface PluginExportState {
	signatures: Record<string, string>;
	pages: Record<
		string,
		{
			plugins: string[];
			assets: string[];
			/** The pluginCss/ stylesheets the page imports — missing in
			 * state from before it was recorded. */
			css?: string[];
			deps?: NoteDeps;
			/** dependencyKey() of `deps` when the page was rendered. */
			depsKey?: string;
		}
	>;
	runtimeCss: Record<string, Record<string, string>>;
	/** pageFormatKey() the cached pages were generated with. */
	pageFormat?: string;
}

const SEARCH_STATE_FILE = ".export-search.json";

const PLUGIN_STATE_FILE = ".export-plugins.json";

/** Everything the export loop reads and updates — see loadExportState(). */
interface ExportState {
	linksMap: LinksMap;
	cache: ExportCache;
	pluginState: PluginExportState;
	/** Plugin integrations whose blocks get rendered this time. */
	active: PluginIntegration[];
	/** Vault paths of every note in this export. */
	exportedNotes: Set<string>;
	/** Vault path → the note's text, for the site's search index. */
	searchText: Record<string, string>;
	site: SiteInfo;
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

		// Vault paths of every note in this export, and their routes — the
		// single source of truth for "which routes should exist right now",
		// reused to pick the default page and drop stale links.json entries.
		const exportedNotes = new Set(
			files.filter((f) => f.extension === "md").map((f) => f.path),
		);
		const expectedRoutes = new Set([...exportedNotes].map(routeOf));

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
			files,
			activeCss,
			obsidianCss.styleSettings,
		);
		patchAppHtml(ctx, staticFiles, styleSettingsClasses);

		const state = this.loadExportState(exportedNotes, expectedRoutes);
		const counts = await this.exportFiles(staticFiles, pages, state);
		this.saveExportState(staticFiles, state);
		const listed = listedNotes(files, ctx.settings.hiddenPaths);
		writeSearchIndex(staticFiles, listed, state.searchText);
		writeSitemap(staticFiles, listed, state.site);
		// Last, once everything the site needs has been copied/written —
		// an export that failed before this point deletes nothing.
		staticFiles.prune();
		pages.prune(isNotePage);

		await this.report(counts);
	}

	/**
	 * Reads what previous exports recorded (link graph, mtime cache, plugin
	 * block data), drops entries for files no longer exported, and works out
	 * which cached pages must be regenerated anyway.
	 */
	private loadExportState(
		exportedNotes: Set<string>,
		expectedRoutes: Set<string>,
	): ExportState {
		const { app, settings, vaultPath, destinationPath, libDir } = this.ctx;
		const currentFilePaths = new Set(this.files.map((f) => f.path));
		const keepCurrent = <T>(record: Record<string, T>, keep: Set<string>) =>
			Object.fromEntries(
				Object.entries(record).filter(([key]) => keep.has(key)),
			);

		// ── Link graph (real wikilinks, for the Graph view) ─────────────────
		// Maps each note's route → the routes of the notes it links to.
		// Loaded first so unchanged (cache-skipped) files keep their
		// previously-recorded links instead of losing them. Entries for notes
		// no longer exported are dropped, or they'd linger in the Graph view
		// forever. Written right away so the file exists on disk immediately
		// — even on a brand new destination, and even if the export loop
		// hits an error.
		const linksJsonPath = path.join(libDir, "links.json");
		const linksMap = keepCurrent(
			readJsonFile<LinksMap>(linksJsonPath, {}),
			expectedRoutes,
		);
		writeJsonFile(linksJsonPath, linksMap);

		// ── Export cache ───────────────────────────────────────────────────
		// Entries for files no longer exported are dropped, so a re-added
		// file at the same vault path re-exports fresh rather than being
		// cache-skipped against a stale mtime.
		const cache = keepCurrent(
			readJsonFile<ExportCache>(
				path.join(destinationPath, EXPORT_CACHE_FILE),
				{},
			),
			currentFilePaths,
		);

		// ── Plugin integrations ──────────────────────────────────────────
		const pluginState: PluginExportState = {
			signatures: {},
			pages: {},
			runtimeCss: {},
			...readJsonFile<Partial<PluginExportState>>(
				path.join(destinationPath, PLUGIN_STATE_FILE),
				{},
			),
		};
		pluginState.pages = keepCurrent(pluginState.pages, currentFilePaths);
		// Pages generated by an older version of the exporter (which may not
		// work with the current svelte-lib/ files), or with other site-wide
		// details baked in, are all regenerated.
		const site = this.siteInfo();
		const pageFormat = JSON.stringify([PAGE_FORMAT_VERSION, site]);
		if (pluginState.pageFormat !== pageFormat) {
			for (const p of Object.keys(cache)) delete cache[p];
			pluginState.pageFormat = pageFormat;
		}
		const searchText = keepCurrent(
			readJsonFile<Record<string, string>>(
				path.join(destinationPath, SEARCH_STATE_FILE),
				{},
			),
			currentFilePaths,
		);
		const active = activeIntegrations(app, settings.disabledIntegrations);
		for (const integration of PLUGIN_INTEGRATIONS) {
			const id = integration.pluginId;
			const signature = integrationSignature(
				app,
				vaultPath,
				integration,
				active.includes(integration),
			);
			if (pluginState.signatures[id] === signature) continue;
			// Turned on/off, updated or reconfigured: every page with one
			// of its blocks must be rendered again, and CSS captured from
			// the previous configuration is stale.
			for (const [filePath, page] of Object.entries(pluginState.pages)) {
				if (page.plugins.includes(id)) delete cache[filePath];
			}
			delete pluginState.runtimeCss[id];
			pluginState.signatures[id] = signature;
		}

		// A page also goes stale when something it depends on changes —
		// a linked note renamed, removed or (de)selected for export, an
		// embedded note edited, an unresolved link that now resolves.
		for (const [filePath, page] of Object.entries(pluginState.pages)) {
			if (
				!page.deps ||
				dependencyKey(app, filePath, page.deps, exportedNotes) !==
					page.depsKey
			) {
				delete cache[filePath];
			}
		}

		return {
			linksMap,
			cache,
			pluginState,
			active,
			exportedNotes,
			searchText,
			site,
		};
	}

	/** The per-file export loop: images are copied, notes rendered (unless
	 * unchanged since the last export). Updates `state` as it goes. */
	private async exportFiles(
		staticFiles: SyncedFolder,
		pages: SyncedFolder,
		{
			linksMap,
			cache,
			pluginState,
			active,
			exportedNotes,
			searchText,
			site,
		}: ExportState,
	): Promise<ExportCounts> {
		const { app, vaultPath } = this.ctx;
		const counts: ExportCounts = { exported: 0, skipped: 0, errors: 0 };
		let processed = 0;
		const exportOne = async (file: TFile) => {
			this.progressModal.update(++processed, file.path);
			try {
				const mtime = file.stat.mtime;
				const ownRoute = routeOf(file.path);

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
					// The mtime cache only skips the (expensive) rendering —
					// and only once this note's links and page data have been
					// recorded at least once, or they'd stay missing.
					const cachedMtime = cache[file.path];
					if (
						cachedMtime !== undefined &&
						cachedMtime >= mtime &&
						ownRoute in linksMap &&
						file.path in pluginState.pages &&
						file.path in searchText
					) {
						counts.skipped++;
						return;
					}
					const result = await exportFile(
						file,
						pages,
						app,
						renderer,
						site,
					);
					linksMap[ownRoute] = result.linkedRoutes;
					searchText[file.path] = result.text;
					pluginState.pages[file.path] = {
						plugins: result.pluginIds,
						assets: result.assets,
						css: result.cssIds,
						deps: result.deps,
						depsKey: dependencyKey(
							app,
							file.path,
							result.deps,
							exportedNotes,
						),
					};
				}

				cache[file.path] = mtime;
				counts.exported++;
			} catch (e) {
				console.error(
					`[SvelteExporter] Failed to export ${file.path}:`,
					e,
				);
				counts.errors++;
			}
		};

		const renderer = new NoteRenderer(app, vaultPath, active, exportedNotes);
		try {
			const queue = [...this.files];
			await Promise.all(
				Array.from({ length: RENDER_CONCURRENCY }, async () => {
					for (let file; (file = queue.shift()); ) await exportOne(file);
				}),
			);
		} finally {
			renderer.dispose();
		}
		for (const [id, chunks] of renderer.runtimeCss) {
			pluginState.runtimeCss[id] = {
				...pluginState.runtimeCss[id],
				...Object.fromEntries(chunks),
			};
		}
		return counts;
	}

	/** Writes everything exportFiles() produced besides the pages
	 * themselves, and records state for the next export. */
	private saveExportState(
		staticFiles: SyncedFolder,
		{ linksMap, cache, pluginState, active, searchText }: ExportState,
	) {
		const { destinationPath, libDir } = this.ctx;
		this.writePluginCss(active, pluginState);
		writeJsonFile(path.join(destinationPath, SEARCH_STATE_FILE), searchText);
		this.copyNoteAssets(staticFiles, pluginState);
		writeJsonFile(path.join(destinationPath, PLUGIN_STATE_FILE), pluginState);
		writeJsonFile(path.join(destinationPath, EXPORT_CACHE_FILE), cache);
		writeJsonFile(path.join(libDir, "links.json"), linksMap);
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
					`⚠️ could not open destination folder: ${
						e instanceof Error ? e.message : String(e)
					}`,
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

	// ── Plugin integrations ────────────────────────────────────────────────

	/**
	 * Writes src/lib/pluginCss/<pluginId>.css for every active integration
	 * (plus runtime CSS like MathJax's) — imported by the pages that need it
	 * (see noteToSvelte in pageexporter.ts). Synced, so a disabled
	 * integration's stylesheet doesn't linger (its pages were re-exported
	 * without the import, since disabling it changed its signature) and an
	 * unchanged one isn't rewritten.
	 */
	private writePluginCss(
		active: PluginIntegration[],
		pluginState: PluginExportState,
	) {
		const { app, vaultPath, libDir } = this.ctx;
		const cssDir = new SyncedFolder(path.join(libDir, "pluginCss"));
		// Runtime CSS not tied to a plugin integration (e.g. MathJax's) —
		// dropped once no page imports it anymore. Unknown while some page's
		// state predates `css` being recorded: kept until then.
		const pages = Object.values(pluginState.pages);
		const imported = pages.every((p) => p.css)
			? new Set(pages.flatMap((p) => p.css ?? []))
			: null;
		const integrationIds = new Set(PLUGIN_INTEGRATIONS.map((i) => i.pluginId));
		for (const [id, chunks] of Object.entries(pluginState.runtimeCss)) {
			if (integrationIds.has(id)) continue;
			if (imported && !imported.has(id)) {
				delete pluginState.runtimeCss[id];
				continue;
			}
			cssDir.write(`${id}.css`, Object.values(chunks).join("\n\n"));
		}
		for (const integration of active) {
			const css = buildIntegrationCss(
				app,
				vaultPath,
				integration,
				Object.values(pluginState.runtimeCss[integration.pluginId] ?? {}),
			);
			cssDir.write(`${integration.pluginId}.css`, css);
		}
		cssDir.prune();
	}

	/** Local files referenced by rendered notes (embedded images, plugin
	 * output…), copied into static/ where their rewritten URLs point (see
	 * assetStaticPath in noteRenderer.ts). */
	private copyNoteAssets(
		staticFiles: SyncedFolder,
		pluginState: PluginExportState,
	) {
		const assets = new Set(
			Object.values(pluginState.pages).flatMap((p) => p.assets),
		);
		for (const asset of assets) {
			try {
				staticFiles.copy(asset, assetStaticPath(asset, this.ctx.vaultPath));
			} catch (e) {
				console.warn(`[SvelteExporter] Could not copy ${asset}:`, e);
			}
		}
	}
}
