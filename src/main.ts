import * as fs from "fs";
import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS } from "./constants";
import { ExportProgressModal } from "./exportModal";
import { SiteExporter } from "./exporter";
import {
	EXPORT_CACHE_FILE,
	getVaultBasePath,
	resolveDestinationPath,
} from "./obsidianUtil";
import {
	DEFAULT_SETTINGS,
	SvelteExporterSettings,
	SvelteExporterSettingTab,
} from "./settings";

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
				this.app.vault.on("create", (file) => {
					void this.onFileCreated(file);
				}),
			);
			// Obsidian implements drag-and-drop moves (and folder renames)
			// as a "rename" event (oldPath → file.path), NOT "create" — by
			// far the most common way a file actually ends up under a
			// different folder, so this has to be handled too, not just
			// brand new files.
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					void this.onFileRenamed(file, oldPath);
				}),
			);
		});
	}

	private async onFileCreated(file: TAbstractFile): Promise<void> {
		if (this.applyParentInheritance(file)) await this.saveSettings();
	}

	private async onFileRenamed(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		let changed = this.remapStoredPaths(oldPath, file.path);
		if (this.applyParentInheritance(file)) changed = true;
		if (changed) await this.saveSettings();
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
		const oldPrefix = oldPath + "/";
		const remap = (paths: string[]): string[] =>
			paths.map((p) => {
				if (p === oldPath) {
					changed = true;
					return newPath;
				}
				if (p.startsWith(oldPrefix)) {
					changed = true;
					return newPath + "/" + p.slice(oldPrefix.length);
				}
				return p;
			});
		this.settings.selectedPaths = remap(this.settings.selectedPaths);
		this.settings.hiddenPaths = remap(this.settings.hiddenPaths);
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
		if (
			this.settings.selectedPaths.includes(parentPath) &&
			!this.settings.selectedPaths.includes(file.path)
		) {
			this.settings.selectedPaths.push(file.path);
			changed = true;
		}
		if (
			this.settings.hiddenPaths.includes(parentPath) &&
			!this.settings.hiddenPaths.includes(file.path)
		) {
			this.settings.hiddenPaths.push(file.path);
			changed = true;
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
				`❌ export failed: ${
					e instanceof Error ? e.message : String(e)
				}. See console for details.`,
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
				(node.extension === "md" ||
					IMAGE_EXTENSIONS.has(node.extension)) &&
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
		return path.join(
			getVaultBasePath(this.app),
			this.manifest.dir ??
				`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
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
		this.settings.selectedPaths.sort();
		this.settings.hiddenPaths.sort();
		await this.saveData(this.settings);
	}
}
