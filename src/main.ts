import * as fs from "fs";
import { Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS, sanitizeRoutePath } from "./constants";
import { exportFile } from "./pageexporter";
import { ensureSvelteProject } from "./scaffold";
import {
	DEFAULT_SETTINGS,
	SvelteExporterSettings,
	SvelteExporterSettingTab,
} from "./settings";

export type ExportCache = Record<string, number>;

export default class SvelteExporterPlugin extends Plugin {
	settings: SvelteExporterSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("globe", "Export to Svelte", () => this.runExport());

		this.addCommand({
			id: "export-md-to-svelte",
			name: "Export selected files to Svelte pages",
			callback: () => this.runExport(),
		});

		this.addSettingTab(new SvelteExporterSettingTab(this.app, this));
	}

	async runExport() {
		const { destinationPath, selectedPaths } = this.settings;

		if (!destinationPath) {
			new Notice(
				"⚠️ Please set a destination path in the plugin settings.",
			);
			return;
		}
		if (!selectedPaths?.length) {
			new Notice(
				"⚠️ No files selected for export. Check the plugin settings.",
			);
			return;
		}

		const files = this.resolveFiles(selectedPaths);
		if (!files.length) {
			new Notice("⚠️ No exportable files found in the selected paths.");
			return;
		}

		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		const pluginDir = path.join(
			vaultPath,
			this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
		);

		const ready = ensureSvelteProject(
			destinationPath,
			pluginDir,
			vaultPath,
			this.settings.selectedTheme ?? "",
		);
		if (!ready) return;

		// ── Write hidden.json ──────────────────────────────────────────────
		const hiddenRoutes = this.resolveHiddenRoutes(
			this.settings.hiddenPaths ?? [],
		);
		const hiddenJsonPath = path.join(
			destinationPath,
			"src",
			"lib",
			"hidden.json",
		);
		fs.writeFileSync(
			hiddenJsonPath,
			JSON.stringify(hiddenRoutes, null, 2),
			"utf-8",
		);

		// ── Write nameMap.json ────────────────────────────────────────────────
		// Maps sanitized route path → original display name, so the FileTree
		// can show "Léoric" instead of "L_oric".
		const nameMap: Record<string, string> = {};
		for (const file of this.resolveFiles(
			this.settings.selectedPaths ?? [],
		)) {
			if (file.extension !== "md") continue;
			nameMap["/" + sanitizeRoutePath(file.path)] = file.basename;
		}
		const nameMapPath = path.join(
			destinationPath,
			"src",
			"lib",
			"nameMap.json",
		);
		fs.writeFileSync(
			nameMapPath,
			JSON.stringify(nameMap, null, 2),
			"utf-8",
		);

		// ── Export cache ───────────────────────────────────────────────────
		const cacheFile = path.join(destinationPath, ".export-cache.json");
		let cache: ExportCache = {};
		if (fs.existsSync(cacheFile)) {
			try {
				cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
			} catch {
				cache = {};
			}
		}

		const staticDir = path.join(destinationPath, "static");
		if (!fs.existsSync(staticDir))
			fs.mkdirSync(staticDir, { recursive: true });

		let exported = 0,
			skipped = 0,
			errors = 0;

		for (const file of files) {
			try {
				const mtime = file.stat.mtime;
				if (
					cache[file.path] !== undefined &&
					cache[file.path] >= mtime
				) {
					skipped++;
					continue;
				}

				if (IMAGE_EXTENSIONS.has(file.extension)) {
					// Copy image to /static/ — served at root URL by SvelteKit
					const srcPath = path.join(vaultPath, file.path);
					const destPath = path.join(staticDir, file.name);
					fs.copyFileSync(srcPath, destPath);
				} else {
					await exportFile(file, destinationPath, this.app.vault);
				}

				cache[file.path] = mtime;
				exported++;
			} catch (e) {
				console.error(
					`[SvelteExporter] Failed to export ${file.path}:`,
					e,
				);
				errors++;
			}
		}

		fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf-8");

		const parts: string[] = [];
		if (exported) parts.push(`✅ ${exported} exported`);
		if (skipped) parts.push(`⏭ ${skipped} skipped (up-to-date)`);
		if (errors) parts.push(`❌ ${errors} error(s)`);
		new Notice(parts.join(" · "));

		if (this.settings.openAfterExport) {
			try {
				const { shell } = require("electron");
				shell.openPath(destinationPath);
			} catch (e) {
				console.error(
					"[SvelteExporter] Could not open destination folder:",
					e,
				);
			}
		}
	}

	// ── Vault file resolution ──────────────────────────────────────────────

	resolveFiles(selectedPaths: string[]): TFile[] {
		const files: TFile[] = [];
		const seen = new Set<string>();

		const add = (file: TFile) => {
			if (!seen.has(file.path)) {
				seen.add(file.path);
				files.push(file);
			}
		};
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFile) {
					if (
						child.extension === "md" ||
						IMAGE_EXTENSIONS.has(child.extension)
					) {
						add(child);
					}
				} else if (child instanceof TFolder) {
					walk(child);
				}
			}
		};

		for (const p of selectedPaths) {
			const node: TAbstractFile | null =
				this.app.vault.getAbstractFileByPath(p);
			if (node instanceof TFile) {
				if (
					node.extension === "md" ||
					IMAGE_EXTENSIONS.has(node.extension)
				)
					add(node);
			} else if (node instanceof TFolder) {
				walk(node);
			}
		}
		return files;
	}

	private resolveHiddenRoutes(hiddenPaths: string[]): string[] {
		return hiddenPaths.map((p) => "/" + p.replace(/\.md$/, ""));
	}

	// ── Cache ──────────────────────────────────────────────────────────────

	async clearCache() {
		const { destinationPath } = this.settings;
		if (destinationPath) {
			const cacheFile = path.join(destinationPath, ".export-cache.json");
			if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
		}
	}

	// ── Persistence ────────────────────────────────────────────────────────

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}
