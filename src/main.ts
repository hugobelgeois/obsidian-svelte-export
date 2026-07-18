import * as fs from "fs";
import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS, sanitizeRoutePath } from "./constants";
import { exportFile } from "./pageexporter";
import { computeStyleSettingsClasses, ensureSvelteProject } from "./scaffold";
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

		this.writeDefaultPage(destinationPath, files);

		// ── Write graphConfig.json ───────────────────────────────────────────
		const graphConfigPath = path.join(
			destinationPath,
			"src",
			"lib",
			"graphConfig.json",
		);
		fs.writeFileSync(
			graphConfigPath,
			JSON.stringify(
				{
					animationType: this.settings.graphAnimationType ?? "heartbeat",
				},
				null,
				2,
			),
			"utf-8",
		);

		// ── Write themeConfig.json ────────────────────────────────────────────
		const themeConfigPath = path.join(
			destinationPath,
			"src",
			"lib",
			"themeConfig.json",
		);
		fs.writeFileSync(
			themeConfigPath,
			JSON.stringify(
				{
					defaultColorMode: this.settings.defaultColorMode ?? "dark",
				},
				null,
				2,
			),
			"utf-8",
		);

		// ── Write styleSettingsClasses.json ─────────────────────────────────
		// The community "Style Settings" plugin (if installed) applies things
		// like ITS Theme's alternate "TTRPG" color schemes by toggling CSS
		// classes on <body> at runtime — classes the exported site otherwise
		// has no way to know about, since they live in that plugin's own
		// data.json rather than in the theme CSS itself.
		const obsidianDir = path.join(vaultPath, ".obsidian");
		const styleSettingsClasses = computeStyleSettingsClasses(
			obsidianDir,
			this.settings.selectedTheme ?? "",
		);
		const styleSettingsClassesPath = path.join(
			destinationPath,
			"src",
			"lib",
			"styleSettingsClasses.json",
		);
		fs.writeFileSync(
			styleSettingsClassesPath,
			JSON.stringify(styleSettingsClasses, null, 2),
			"utf-8",
		);

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
		// can show "Léoric" instead of "Leoric". This covers both leaf pages
		// (md files) AND every ancestor folder, so folder names in the tree
		// also keep their original spelling/accents instead of the
		// sanitized route segment.
		const nameMap: Record<string, string> = {};
		for (const file of files) {
			if (file.extension !== "md") continue;
			nameMap["/" + sanitizeRoutePath(file.path)] = file.basename;

			let parent = file.parent;
			while (parent && parent.path && parent.path !== "/") {
				nameMap["/" + sanitizeRoutePath(parent.path)] = parent.name;
				parent = parent.parent;
			}
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

		// ── Link graph (real wikilinks, for the Graph view) ─────────────────
		// Maps each note's route → the routes of the notes it links to.
		// Loaded first so unchanged (cache-skipped) files keep their
		// previously-recorded links instead of losing them. Written right
		// away (like hidden.json/nameMap.json above) so the file exists on
		// disk immediately — even on a brand new destination with nothing in
		// it yet, and even if the export loop below hits an error — instead
		// of only appearing once the whole export finishes.
		const linksJsonPath = path.join(
			destinationPath,
			"src",
			"lib",
			"links.json",
		);
		let linksMap: Record<string, string[]> = {};
		if (fs.existsSync(linksJsonPath)) {
			try {
				linksMap = JSON.parse(fs.readFileSync(linksJsonPath, "utf-8"));
			} catch {
				linksMap = {};
			}
		}
		fs.writeFileSync(
			linksJsonPath,
			JSON.stringify(linksMap, null, 2),
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
		// Tells GitHub Pages to skip Jekyll processing, which otherwise
		// silently drops any file/folder starting with an underscore —
		// including SvelteKit's own _app/ build output.
		fs.writeFileSync(path.join(staticDir, ".nojekyll"), "", "utf-8");

		let exported = 0,
			skipped = 0,
			errors = 0;

		for (const file of files) {
			try {
				const mtime = file.stat.mtime;
				const isImage = IMAGE_EXTENSIONS.has(file.extension);
				const ownRoute = "/" + sanitizeRoutePath(file.path);
				// A file whose links were never recorded (e.g. right after
				// upgrading to this feature) must be re-exported even if the
				// mtime cache would otherwise skip it, or its links.json
				// entry would stay permanently missing.
				const hasLinkData =
					isImage ||
					Object.prototype.hasOwnProperty.call(linksMap, ownRoute);

				// scaffold.ts wipes static/ on every export (clean slate), so
				// images must always be re-copied — the mtime cache can only
				// be trusted to skip the (expensive) markdown transform.
				if (
					!isImage &&
					hasLinkData &&
					cache[file.path] !== undefined &&
					cache[file.path] >= mtime
				) {
					skipped++;
					continue;
				}

				if (isImage) {
					// Copy image to /static/ — served at root URL by SvelteKit
					const srcPath = path.join(vaultPath, file.path);
					const destPath = path.join(staticDir, file.name);
					fs.copyFileSync(srcPath, destPath);
				} else {
					const linkedRoutes = await exportFile(
						file,
						destinationPath,
						this.app.vault,
					);
					linksMap[ownRoute] = linkedRoutes;
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
		fs.writeFileSync(
			linksJsonPath,
			JSON.stringify(linksMap, null, 2),
			"utf-8",
		);

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

	/**
	 * Resolve `selectedPaths` to actual exportable files.
	 *
	 * `selectedPaths` already contains every individual file path that
	 * should be exported — when a folder is checked in settings.ts,
	 * `selectAllDescendants` explicitly adds each descendant file (and
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

	private resolveHiddenRoutes(hiddenPaths: string[]): string[] {
		// Must match the same sanitization used when generating each file's
		// actual route (see pageexporter.ts / nameMap below) — otherwise a
		// hidden path with accents/spaces/special characters never matches
		// the sanitized route the FileTree actually compares against.
		return hiddenPaths.map((p) => "/" + sanitizeRoutePath(p));
	}

	/**
	 * Generates the site's root page (src/routes/+page.svelte + +page.ts)
	 * according to the "Default page" setting:
	 * - "" (default): leave the welcome-screen template that
	 *   ensureSvelteProject just copied from svelte-lib/routes/+page.svelte
	 *   untouched.
	 * - "__graph__": show the graph view as a normal full page, not a popup.
	 * - anything else: a route path — redirect "/" to that note.
	 */
	private writeDefaultPage(destinationPath: string, files: TFile[]) {
		const defaultPage = this.settings.defaultPage ?? "";
		if (defaultPage === "") return;

		const routesDir = path.join(destinationPath, "src", "routes");
		const pageSveltePath = path.join(routesDir, "+page.svelte");
		const pageTsPath = path.join(routesDir, "+page.ts");

		if (defaultPage === "__graph__") {
			fs.writeFileSync(
				pageSveltePath,
				'<script lang="ts">\n\timport Graph from "$lib/Graph.svelte";\n</script>\n\n<Graph standalone />\n',
				"utf-8",
			);
			fs.writeFileSync(
				pageTsPath,
				"export const prerender = true;\n\n" +
					"// Resolved before any component renders, so Body.svelte and\n" +
					"// +layout.svelte can size/lay out the page correctly on the very\n" +
					"// first (server-rendered) paint — unlike a store a child component\n" +
					"// would set too late. isGraphPage (distinct from fullBleed, which a\n" +
					"// full-width note also sets) is what tells +layout.svelte to hide\n" +
					"// the right sidebar's own redundant mini-graph on this route.\n" +
					"export const load = () => ({ fullBleed: true, isGraphPage: true });\n",
				"utf-8",
			);
			return;
		}

		// A specific note's route — but only redirect there if it's still
		// actually part of the current export selection; otherwise silently
		// fall back to the welcome screen rather than shipping a redirect
		// to a page that was never generated.
		const validRoutes = new Set(
			files
				.filter((f) => f.extension === "md")
				.map((f) => "/" + sanitizeRoutePath(f.path)),
		);
		if (!validRoutes.has(defaultPage)) return;

		const target = defaultPage.endsWith("/")
			? defaultPage
			: defaultPage + "/";
		fs.writeFileSync(
			pageSveltePath,
			`<!-- Redirects to ${target} — see +page.ts -->\n`,
			"utf-8",
		);
		fs.writeFileSync(
			pageTsPath,
			'import { redirect } from "@sveltejs/kit";\n' +
				'import { base } from "$app/paths";\n\n' +
				"export const prerender = true;\n\n" +
				"export const load = () => {\n" +
				// `target` is base-less — the real site base (e.g. on a
				// GitHub Pages project page) has to be prepended, same as
				// any other internal link.
				`\tthrow redirect(307, base + ${JSON.stringify(target)});\n` +
				"};\n",
			"utf-8",
		);
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
