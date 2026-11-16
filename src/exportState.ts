import * as fs from "fs";
import { TFile } from "obsidian";
import * as path from "path";
import { routeOf } from "./constants";
import type { ExportContext } from "./exporter";
import { assetStaticPath, dependencyKey, NoteDeps } from "./noteRenderer";
import {
	EXPORT_CACHE_FILE,
	readJsonFile,
	writeJsonFile,
} from "./obsidianUtil";
import { ExportResult, PAGE_FORMAT_VERSION, SiteInfo } from "./pageexporter";
import {
	activeIntegrations,
	buildIntegrationCss,
	integrationSignature,
	PLUGIN_INTEGRATIONS,
	PluginIntegration,
} from "./pluginIntegrations";
import { SyncedFolder } from "./syncedFolder";

/**
 * What an export remembers for the next one (state files in the destination
 * folder) — what lets a note that didn't change, nor anything its page
 * depends on, be skipped instead of rendered again. SiteExporter
 * (exporter.ts) loads it, updates it as notes are rendered, and saves it.
 */

/** Vault path → mtime of the file when it was last exported. Kept apart
 * from the pages' state: it's what the settings tab reads (✓ marks, cache
 * size) and what "Clear cache" deletes, so it stays small. */
type ExportCache = Record<string, number>;

/** What an export recorded about one note's page — everything a
 * cache-skipped note's page still contributes to the site. */
export interface PageState {
	/** Routes of the exported notes it links to or embeds (links.json). */
	links: string[];
	/** Its visible text, for the site's search index. */
	text: string;
	/** Integrations with a code block in the note (see RenderedNote). */
	plugins: string[];
	/** Local files the page references — static/ keeps only what each
	 * export records, so they're recorded even for cache-skipped pages. */
	assets: string[];
	/** The pluginCss/ stylesheets the page imports. */
	css: string[];
	deps: NoteDeps;
	/** dependencyKey() of `deps` when the page was rendered. */
	depsKey: string;
}

/** .export-pages.json — every page's state, plus what's shared by all of
 * them: the integrations' signatures (a change re-renders the pages using
 * them) and the runtime CSS captured while rendering. */
interface PagesFile {
	signatures: Record<string, string>;
	pages: Record<string, PageState>;
	runtimeCss: Record<string, Record<string, string>>;
	/** The page format and site details the cached pages were generated
	 * with — see loadExportState(). */
	pageFormat?: string;
}

const PAGES_STATE_FILE = ".export-pages.json";
/** What PAGES_STATE_FILE replaced — deleted on the next export (their
 * notes are all rendered again once, since no page state is found). */
const LEGACY_STATE_FILES = [".export-plugins.json", ".export-search.json"];

/** Everything the export loop reads and updates. */
export interface ExportState {
	cache: ExportCache;
	pageState: PagesFile;
	/** Plugin integrations whose blocks get rendered this time. */
	active: PluginIntegration[];
	/** Vault paths of every note in this export. */
	exportedNotes: Set<string>;
	site: SiteInfo;
}

const linksJsonPath = (ctx: ExportContext) =>
	path.join(ctx.libDir, "links.json");

/** links.json — note route → routes of the notes it links to, read by the
 * site's graph view. */
function linksJson(pages: Record<string, PageState>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(pages).map(([p, page]) => [routeOf(p), page.links]),
	);
}

/**
 * Reads what previous exports recorded (mtime cache, page state), drops
 * entries for files no longer exported, and works out which cached pages
 * must be regenerated anyway.
 */
export function loadExportState(
	ctx: ExportContext,
	files: TFile[],
	exportedNotes: Set<string>,
	site: SiteInfo,
): ExportState {
	const { app, settings, vaultPath, destinationPath } = ctx;
	const currentFilePaths = new Set(files.map((f) => f.path));
	const keepCurrent = <T>(record: Record<string, T>) =>
		Object.fromEntries(
			Object.entries(record).filter(([key]) => currentFilePaths.has(key)),
		);

	// ── Export cache ───────────────────────────────────────────────────
	// Entries for files no longer exported are dropped, so a re-added
	// file at the same vault path re-exports fresh rather than being
	// cache-skipped against a stale mtime.
	const cache = keepCurrent(
		readJsonFile<ExportCache>(
			path.join(destinationPath, EXPORT_CACHE_FILE),
			{},
		),
	);

	// ── Page state ─────────────────────────────────────────────────────
	const pageState: PagesFile = {
		signatures: {},
		pages: {},
		runtimeCss: {},
		...readJsonFile<Partial<PagesFile>>(
			path.join(destinationPath, PAGES_STATE_FILE),
			{},
		),
	};
	// Pages of notes no longer exported are dropped, or their links would
	// linger in the Graph view (and their text in search) forever.
	pageState.pages = keepCurrent(pageState.pages);

	// The link graph is written right away, so links.json exists on disk
	// immediately — even on a brand new destination, and even if the
	// export loop hits an error.
	writeJsonFile(linksJsonPath(ctx), linksJson(pageState.pages));

	// Pages generated by an older version of the exporter (which may not
	// work with the current svelte-lib/ files), or with other site-wide
	// details baked in, are all regenerated.
	const pageFormat = JSON.stringify([PAGE_FORMAT_VERSION, site]);
	if (pageState.pageFormat !== pageFormat) {
		for (const p of Object.keys(cache)) delete cache[p];
		pageState.pageFormat = pageFormat;
	}

	// ── Plugin integrations ──────────────────────────────────────────
	const active = activeIntegrations(app, settings.disabledIntegrations);
	for (const integration of PLUGIN_INTEGRATIONS) {
		const id = integration.pluginId;
		const signature = integrationSignature(
			app,
			vaultPath,
			integration,
			active.includes(integration),
		);
		if (pageState.signatures[id] === signature) continue;
		// Turned on/off, updated or reconfigured: every page with one
		// of its blocks must be rendered again, and CSS captured from
		// the previous configuration is stale.
		for (const [filePath, page] of Object.entries(pageState.pages)) {
			if (page.plugins.includes(id)) delete cache[filePath];
		}
		delete pageState.runtimeCss[id];
		pageState.signatures[id] = signature;
	}

	// A page also goes stale when something it depends on changes —
	// a linked note renamed, removed or (de)selected for export, an
	// embedded note edited, an unresolved link that now resolves.
	for (const [filePath, page] of Object.entries(pageState.pages)) {
		if (
			dependencyKey(app, filePath, page.deps, exportedNotes) !==
			page.depsKey
		) {
			delete cache[filePath];
		}
	}

	return { cache, pageState, active, exportedNotes, site };
}

/**
 * Whether the page a previous export generated for `note` is still valid:
 * the note is unchanged since (and so is everything its page depends on —
 * see loadExportState), and its page state was recorded then, or what the
 * page contributes to the site (links, text, assets…) would stay missing.
 */
export function isUpToDate(state: ExportState, note: TFile): boolean {
	const cachedMtime = state.cache[note.path];
	return (
		cachedMtime !== undefined &&
		cachedMtime >= note.stat.mtime &&
		note.path in state.pageState.pages
	);
}

/** Records what rendering `note` produced. */
export function recordPage(
	ctx: ExportContext,
	state: ExportState,
	note: TFile,
	{ linkedRoutes, text, plugins, assets, css, deps }: ExportResult,
): void {
	state.pageState.pages[note.path] = {
		links: linkedRoutes,
		text,
		plugins,
		assets,
		css,
		deps,
		depsKey: dependencyKey(ctx.app, note.path, deps, state.exportedNotes),
	};
}

/** Records that `file` (note or image) was exported as of `mtime` — read
 * before exporting it: if it's edited meanwhile, the next export must
 * still see it as changed. */
export function recordExported(
	state: ExportState,
	file: TFile,
	mtime: number,
): void {
	state.cache[file.path] = mtime;
}

/** Merges the runtime CSS captured while rendering (NoteRenderer's
 * runtimeCss) into what earlier exports captured. */
export function recordRuntimeCss(
	state: ExportState,
	runtimeCss: Map<string, Map<string, string>>,
): void {
	const saved = state.pageState.runtimeCss;
	for (const [id, chunks] of runtimeCss) {
		saved[id] = { ...saved[id], ...Object.fromEntries(chunks) };
	}
}

/** Writes everything the export loop produced besides the pages
 * themselves, and records state for the next export. */
export function saveExportState(
	ctx: ExportContext,
	staticFiles: SyncedFolder,
	state: ExportState,
): void {
	const { destinationPath } = ctx;
	const { cache, pageState, active } = state;
	writePluginCss(ctx, active, pageState);
	copyNoteAssets(ctx, staticFiles, pageState);
	writeJsonFile(path.join(destinationPath, PAGES_STATE_FILE), pageState);
	writeJsonFile(path.join(destinationPath, EXPORT_CACHE_FILE), cache);
	writeJsonFile(linksJsonPath(ctx), linksJson(pageState.pages));
	for (const legacy of LEGACY_STATE_FILES) {
		fs.rmSync(path.join(destinationPath, legacy), { force: true });
	}
}

/**
 * Writes src/lib/pluginCss/<pluginId>.css for every active integration
 * (plus runtime CSS like MathJax's) — imported by the pages that need it
 * (see noteToSvelte in pageexporter.ts). Synced, so a disabled
 * integration's stylesheet doesn't linger (its pages were re-exported
 * without the import, since disabling it changed its signature) and an
 * unchanged one isn't rewritten.
 */
function writePluginCss(
	ctx: ExportContext,
	active: PluginIntegration[],
	pageState: PagesFile,
) {
	const { app, vaultPath, libDir } = ctx;
	const cssDir = new SyncedFolder(path.join(libDir, "pluginCss"));
	// Runtime CSS not tied to a plugin integration (e.g. MathJax's) —
	// dropped once no page imports it anymore.
	const imported = new Set(
		Object.values(pageState.pages).flatMap((p) => p.css),
	);
	const integrationIds = new Set(PLUGIN_INTEGRATIONS.map((i) => i.pluginId));
	for (const [id, chunks] of Object.entries(pageState.runtimeCss)) {
		if (integrationIds.has(id)) continue;
		if (!imported.has(id)) {
			delete pageState.runtimeCss[id];
			continue;
		}
		cssDir.write(`${id}.css`, Object.values(chunks).join("\n\n"));
	}
	for (const integration of active) {
		const css = buildIntegrationCss(
			app,
			vaultPath,
			integration,
			Object.values(pageState.runtimeCss[integration.pluginId] ?? {}),
		);
		cssDir.write(`${integration.pluginId}.css`, css);
	}
	cssDir.prune();
}

/** Local files referenced by rendered notes (embedded images, plugin
 * output…), copied into static/ where their rewritten URLs point (see
 * assetStaticPath in noteRenderer.ts). */
function copyNoteAssets(
	ctx: ExportContext,
	staticFiles: SyncedFolder,
	pageState: PagesFile,
) {
	const assets = new Set(
		Object.values(pageState.pages).flatMap((p) => p.assets),
	);
	for (const asset of assets) {
		try {
			staticFiles.copy(asset, assetStaticPath(asset, ctx.vaultPath));
		} catch (e) {
			console.warn(`[SvelteExporter] Could not copy ${asset}:`, e);
		}
	}
}
