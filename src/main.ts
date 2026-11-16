import * as fs from "fs";
import { debounce, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import * as path from "path";
import { addAncestors, isExportable, isWithin } from "./constants";
import { ExportProgressModal } from "./exportModal";
import { SiteExporter } from "./exporter";
import {
	errorMessage,
	EXPORT_CACHE_FILE,
	getVaultBasePath,
	pluginFolderPath,
	resolveDestinationPath,
} from "./obsidianUtil";
import {
	DEFAULT_SETTINGS,
	PATH_LISTS,
	SvelteExporterSettings,
	SvelteExporterSettingTab,
} from "./settings";

/** A stored path list's entries and every folder they're under, for O(1)
 * lookups — see pathIndex(). */
class PathIndex {
	readonly paths: Set<string>;
	readonly ancestors = new Set<string>();
	/** The list's length when this was last brought up to date. */
	length: number;

	constructor(private readonly list: string[]) {
		this.paths = new Set(list);
		for (const p of list) addAncestors(p, this.ancestors);
		this.length = list.length;
	}

	/** Records `p`, just pushed onto the list. */
	add(p: string): void {
		this.paths.add(p);
		addAncestors(p, this.ancestors);
		this.length = this.list.length;
	}
}

/** Built once per list, kept while it's the same array with the same
 * length. Every change to a list either replaces the array (remapping,
 * the settings tab's removals and cascades, loading) or pushes onto it
 * (then the length differs, or add() was called) — sorting it in place
 * changes nothing that's indexed. So a folder move's k rename events cost
 * one O(n) index build, not k O(n) scans. */
const pathIndexes = new WeakMap<string[], PathIndex>();

function pathIndex(list: string[]): PathIndex {
	let index = pathIndexes.get(list);
	if (!index || index.length !== list.length) {
		index = new PathIndex(list);
		pathIndexes.set(list, index);
	}
	return index;
}

export default class SvelteExporterPlugin extends Plugin {
	settings: SvelteExporterSettings;
	private exporting = false;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("globe", "Export to Svelte", () => this.runExport());

		this.addCommand({
			id: "export-md-to-svelte",
			name: "Export selected files to Svelte pages",
			callback: () => this.runExport(),
		});

		this.addSettingTab(new SvelteExporterSettingTab(this.app, this));

		// Deferred past initial vault indexing (onLayoutReady) — both events
		// fire for every existing file while Obsidian first resolves the
		// vault too, and none of those are actually new/moved.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => this.onFileCreated(file)),
			);
			// Obsidian implements drag-and-drop moves (and folder renames)
			// as a "rename" event (oldPath → file.path), NOT "create" — by
			// far the most common way a file actually ends up under a
			// different folder, so this has to be handled too, not just
			// brand new files.
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) =>
					this.onFileRenamed(file, oldPath),
				),
			);
		});
	}

	onunload() {
		// A change from a vault event just before the plugin is disabled
		// (or Obsidian closes) still gets saved.
		this.saveSoon.run();
	}

	/**
	 * Saves settings changed by vault events, debounced: moving or renaming
	 * a folder fires one "rename" per file in it, and each would otherwise
	 * sort both path lists and rewrite data.json — k writes for k files.
	 * The settings in memory (what an export or the settings tab reads)
	 * are up to date right away.
	 */
	private readonly saveSoon = debounce(
		() => void this.saveSettings(),
		500,
		true,
	);

	private onFileCreated(file: TAbstractFile): void {
		if (this.applyParentInheritance(file)) this.saveSoon();
	}

	private onFileRenamed(file: TAbstractFile, oldPath: string): void {
		let changed = this.remapStoredPaths(oldPath, file.path);
		if (this.applyParentInheritance(file)) changed = true;
		if (changed) this.saveSoon();
	}

	/**
	 * Rewrites every selectedPaths/hiddenPaths entry that pointed at
	 * `oldPath` (or was nested under it, for a moved/renamed folder) to
	 * `newPath`. Without this, a rename or a drag-and-drop move silently
	 * drops an explicitly exported/hidden file — or an entire folder's
	 * worth of descendants — out of both lists, since every entry is a
	 * plain path string keyed to wherever the item used to be.
	 */
	private remapStoredPaths(oldPath: string, newPath: string): boolean {
		let changed = false;
		for (const list of PATH_LISTS) {
			// Nothing at or under oldPath: the usual case — e.g. each file
			// of a moved folder gets its own event, after the folder's
			// already remapped them all — answered without a scan.
			const index = pathIndex(this.settings[list]);
			if (!index.paths.has(oldPath) && !index.ancestors.has(oldPath)) {
				continue;
			}
			this.settings[list] = this.settings[list].map((p) => {
				if (!isWithin(p, oldPath)) return p;
				changed = true;
				return newPath + p.slice(oldPath.length);
			});
		}
		return changed;
	}

	/**
	 * A new (or newly moved-in) file/folder inherits its parent folder's
	 * export selection and hidden state, mirroring the cascade
	 * addDescendants applies when the parent itself
	 * is toggled in fileSelector.ts. Without this, a note dropped into an
	 * already-exported folder is silently never exported until the user
	 * re-opens settings and toggles it by hand — selectedPaths/hiddenPaths
	 * only ever contain paths that existed at the time a folder was
	 * checked/hidden. Returns whether anything changed, so callers can
	 * decide when to persist rather than saving twice.
	 */
	private applyParentInheritance(file: TAbstractFile): boolean {
		const parentPath = file.parent?.path;
		if (parentPath === undefined) return false;

		let changed = false;
		for (const list of PATH_LISTS) {
			const paths = this.settings[list];
			const index = pathIndex(paths);
			if (index.paths.has(parentPath) && !index.paths.has(file.path)) {
				paths.push(file.path);
				index.add(file.path);
				changed = true;
			}
		}
		return changed;
	}

	/** The export itself lives in exporter.ts (SiteExporter). */
	async runExport() {
		// Two exports at once (e.g. a double click on the ribbon icon) would
		// both wipe and rewrite static/, the routes and the state files.
		if (this.exporting) {
			new Notice("⚠️ an export is already running.");
			return;
		}
		const files = this.filesToExport();
		if (!files) return;

		this.exporting = true;
		const progressModal = new ExportProgressModal(this.app, files.length);
		progressModal.open();
		try {
			await new SiteExporter(
				this.app,
				this.settings,
				this.getPluginDir(),
				files,
				progressModal,
			).run();
		} catch (e) {
			// Anything thrown here (a locked file on Windows, a full disk…)
			// would otherwise be an unhandled rejection, leaving the progress
			// modal open forever with no word of what went wrong.
			console.error("[SvelteExporter] Export failed:", e);
			progressModal.close();
			new Notice(
				`❌ export failed: ${errorMessage(e)}. See console for details.`,
			);
		} finally {
			this.exporting = false;
		}
	}

	/** The files to export, or null (after telling the user why) if the
	 * export can't run. */
	private filesToExport(): TFile[] | null {
		const { destinationPath, selectedPaths } = this.settings;
		if (!destinationPath) {
			new Notice(
				"⚠️ please set a destination path in the plugin settings.",
			);
			return null;
		}
		if (!selectedPaths.length) {
			new Notice(
				"⚠️ no files selected for export. Check the plugin settings.",
			);
			return null;
		}
		const files = this.resolveFiles(selectedPaths);
		if (!files.length) {
			new Notice("⚠️ no exportable files found in the selected paths.");
			return null;
		}
		return files;
	}

	// ── Vault file resolution ──────────────────────────────────────────────

	/**
	 * Resolve `selectedPaths` to actual exportable files.
	 *
	 * `selectedPaths` already contains every individual file path that
	 * should be exported — when a folder is checked in fileSelector.ts,
	 * `addDescendants` explicitly adds each descendant file (and
	 * subfolder) to the list. So we only need to pick out the TFile
	 * entries here; we must NOT re-walk folders, or an individually
	 * unchecked child file would get re-included via its still-checked
	 * parent folder.
	 */
	resolveFiles(selectedPaths: string[]): TFile[] {
		const files: TFile[] = [];
		const seen = new Set<string>();

		for (const p of selectedPaths) {
			const node: TAbstractFile | null =
				this.app.vault.getAbstractFileByPath(p);
			if (
				node instanceof TFile &&
				isExportable(node) &&
				!seen.has(node.path)
			) {
				seen.add(node.path);
				files.push(node);
			}
		}
		return files;
	}

	/** Absolute path of this plugin's own folder (holds svelte-lib/). */
	getPluginDir(): string {
		return pluginFolderPath(
			this.app,
			getVaultBasePath(this.app),
			this.manifest.id,
			this.manifest.dir,
		);
	}

	/** Absolute path of the export cache file, or null if no destination is set. */
	getCacheFilePath(): string | null {
		const { destinationPath } = this.settings;
		if (!destinationPath) return null;
		return path.join(
			resolveDestinationPath(getVaultBasePath(this.app), destinationPath),
			EXPORT_CACHE_FILE,
		);
	}

	// ── Cache ──────────────────────────────────────────────────────────────

	clearCache() {
		const cacheFile = this.getCacheFilePath();
		if (cacheFile) fs.rmSync(cacheFile, { force: true });
	}

	// ── Persistence ────────────────────────────────────────────────────────

	async loadSettings() {
		const saved = (await this.loadData()) as
			| Partial<SvelteExporterSettings>
			| null;
		// Deep-copied: a shallow merge alone means a list missing from
		// data.json would otherwise be DEFAULT_SETTINGS' own array, and the
		// in-place push()es (applyParentInheritance…) would mutate it.
		this.settings = structuredClone({ ...DEFAULT_SETTINGS, ...saved });
		// Settings that no longer exist — dropped so they don't linger in data.json.
		const settings = this.settings as unknown as Record<string, unknown>;
		delete settings.markdownStyle;
		delete settings.customCssPath;
	}
	async saveSettings() {
		// Sorted so data.json diffs stay minimal regardless of the order
		// paths were toggled in.
		for (const list of PATH_LISTS) this.settings[list].sort();
		await this.saveData(this.settings);
	}
}
