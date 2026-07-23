import * as fs from "fs";
import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import * as path from "path";
import {
	sanitizeJsonHtmlLinks,
	sanitizeRoutePath,
	STATIC_PASSTHROUGH_EXTENSIONS,
} from "./constants";
import { openInFileExplorer } from "./electronDialog";
import { ExportProgressModal } from "./exportModal";
import { computeNodeColors } from "./graphColors";
import { getVaultBasePath } from "./obsidianUtil";
import { exportFile } from "./pageexporter";
import { computeStyleSettingsClasses, ensureSvelteProject } from "./scaffold";
import {
	DEFAULT_SETTINGS,
	SvelteExporterSettings,
	SvelteExporterSettingTab,
} from "./settings";

export type ExportCache = Record<string, number>;
type LinksMap = Record<string, string[]>;

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
				"⚠️ please set a destination path in the plugin settings.",
			);
			return;
		}
		if (!selectedPaths?.length) {
			new Notice(
				"⚠️ no files selected for export. Check the plugin settings.",
			);
			return;
		}

		const files = this.resolveFiles(selectedPaths);
		if (!files.length) {
			new Notice("⚠️ no exportable files found in the selected paths.");
			return;
		}

		const vaultPath = getVaultBasePath(this.app);
		const pluginDir = path.join(
			vaultPath,
			this.manifest.dir ??
				`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);

		const progressModal = new ExportProgressModal(this.app, files.length);
		progressModal.open();

		const ready = await ensureSvelteProject(
			destinationPath,
			pluginDir,
			vaultPath,
			this.app.vault.configDir,
			this.settings.selectedTheme ?? "",
			(status) => progressModal.setPreparing(status),
		);
		if (!ready) {
			progressModal.close();
			return;
		}

		this.writeDefaultPage(destinationPath, files);
		this.writeFavicon(destinationPath, vaultPath);
		this.writeCustomScripts(destinationPath, vaultPath);

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
		const obsidianDir = path.join(vaultPath, this.app.vault.configDir);
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

		// ── Write nodeColors.json ────────────────────────────────────────────
		// Obsidian's own graph view "Groups" — colors notes matching a saved
		// query (e.g. path:Bestiaire). Reused here so the exported graph's
		// big view looks the same, without asking the user to redefine
		// groups a second time in this plugin's own settings.
		const nodeColors = this.settings.exportGraphColors
			? computeNodeColors(this.app, obsidianDir, files)
			: {};
		const nodeColorsPath = path.join(
			destinationPath,
			"src",
			"lib",
			"nodeColors.json",
		);
		fs.writeFileSync(
			nodeColorsPath,
			JSON.stringify(nodeColors, null, 2),
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
		let linksMap: LinksMap = {};
		if (fs.existsSync(linksJsonPath)) {
			try {
				linksMap = JSON.parse(
					fs.readFileSync(linksJsonPath, "utf-8"),
				) as LinksMap;
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
				cache = JSON.parse(
					fs.readFileSync(cacheFile, "utf-8"),
				) as ExportCache;
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

		let processed = 0;
		for (const file of files) {
			processed++;
			progressModal.update(processed, file.path);
			try {
				const mtime = file.stat.mtime;
				const isStaticPassthrough = STATIC_PASSTHROUGH_EXTENSIONS.has(
					file.extension,
				);
				const ownRoute = "/" + sanitizeRoutePath(file.path);
				// A file whose links were never recorded (e.g. right after
				// upgrading to this feature) must be re-exported even if the
				// mtime cache would otherwise skip it, or its links.json
				// entry would stay permanently missing.
				const hasLinkData =
					isStaticPassthrough ||
					Object.prototype.hasOwnProperty.call(linksMap, ownRoute);

				// scaffold.ts wipes static/ on every export (clean slate), so
				// these files must always be re-copied — the mtime cache can
				// only be trusted to skip the (expensive) markdown transform.
				const cachedMtime = cache[file.path];
				if (
					!isStaticPassthrough &&
					hasLinkData &&
					cachedMtime !== undefined &&
					cachedMtime >= mtime
				) {
					skipped++;
					continue;
				}

				if (isStaticPassthrough) {
					// Copy flat to /static/ — served at root URL by SvelteKit
					const srcPath = path.join(vaultPath, file.path);
					const destPath = path.join(staticDir, file.name);
					if (file.extension === "json") {
						// Rewrite href="/..." links embedded in the JSON
						// (e.g. Map Manager's pre-rendered note HTML) so
						// their accented paths/fragments match the site's
						// sanitized routes — falls back to a byte-identical
						// copy if the file isn't valid JSON.
						try {
							const raw = fs.readFileSync(srcPath, "utf-8");
							const rewritten = sanitizeJsonHtmlLinks(
								JSON.parse(raw),
							);
							fs.writeFileSync(
								destPath,
								JSON.stringify(rewritten, null, "\t"),
								"utf-8",
							);
						} catch {
							fs.copyFileSync(srcPath, destPath);
						}
					} else {
						fs.copyFileSync(srcPath, destPath);
					}
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
		const summary = parts.join(" · ");

		progressModal.finish(summary);
		setTimeout(() => progressModal.close(), 1200);

		new Notice(summary);

		if (this.settings.openAfterExport) {
			try {
				openInFileExplorer(destinationPath);
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
					STATIC_PASSTHROUGH_EXTENSIONS.has(node.extension)) &&
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

	/**
	 * Copies the chosen favicon image into static/ and points app.html's
	 * <link rel="icon"> at it — app.html isn't one of svelte-lib's own
	 * templates (it's `sv create`'s, generated once and never touched again
	 * by copyPluginFiles), so this patches it directly, on every export,
	 * idempotently: any icon link this method previously added is stripped
	 * first, so switching images (or clearing the setting) never leaves a
	 * stale/duplicate tag behind.
	 */
	private writeFavicon(destinationPath: string, vaultPath: string) {
		const appHtmlPath = path.join(destinationPath, "src", "app.html");
		if (!fs.existsSync(appHtmlPath)) return;

		let html = fs.readFileSync(appHtmlPath, "utf-8");
		html = html.replace(
			/[ \t]*<link rel="icon"[^>]*data-svelte-exporter-favicon[^>]*>\n?/,
			"",
		);

		const faviconPath = this.settings.faviconPath?.trim();
		if (faviconPath) {
			const srcPath = path.join(vaultPath, faviconPath);
			if (fs.existsSync(srcPath)) {
				const ext = path.extname(srcPath).toLowerCase() || ".png";
				const staticDir = path.join(destinationPath, "static");
				if (!fs.existsSync(staticDir)) {
					fs.mkdirSync(staticDir, { recursive: true });
				}
				fs.copyFileSync(srcPath, path.join(staticDir, `favicon${ext}`));

				const mimeByExt: Record<string, string> = {
					".png": "image/png",
					".svg": "image/svg+xml",
					".ico": "image/x-icon",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".gif": "image/gif",
					".webp": "image/webp",
				};
				const mime = mimeByExt[ext] ?? "image/png";
				// %sveltekit.assets% (not a hardcoded "/favicon...") — this
				// placeholder is filled in by SvelteKit itself with the
				// correct base-prefixed assets path, so the icon still
				// resolves under a GitHub Pages-style "/<repo>/" subpath.
				const tag =
					`\t\t<link rel="icon" href="%sveltekit.assets%/favicon${ext}" ` +
					`type="${mime}" data-svelte-exporter-favicon />\n`;
				html = html.replace(
					"%sveltekit.head%",
					`${tag}\t\t%sveltekit.head%`,
				);
			} else {
				new Notice(
					`⚠️ Favicon file not found in vault: ${faviconPath}`,
				);
			}
		}

		fs.writeFileSync(appHtmlPath, html, "utf-8");
	}

	/**
	 * Copies every file in customScriptPaths into src/lib/customScripts/ —
	 * picked up at build time by the import.meta.glob() call in
	 * svelte-lib/routes/+layout.svelte, which awaits each module after the
	 * page mounts and calls its default export (if it's a function). The
	 * folder is wiped and rewritten on every export (like static/ in
	 * scaffold.ts) so a script removed from settings doesn't linger in the
	 * exported project. Subfolders are flattened into the filename (e.g.
	 * "scripts/foo.ts" → "scripts__foo.ts") so two files with the same
	 * basename in different vault folders can't collide once copied flat.
	 */
	private writeCustomScripts(destinationPath: string, vaultPath: string) {
		const scriptsDir = path.join(
			destinationPath,
			"src",
			"lib",
			"customScripts",
		);
		if (fs.existsSync(scriptsDir)) {
			fs.rmSync(scriptsDir, { recursive: true, force: true });
		}

		const scriptPaths = this.settings.customScriptPaths ?? [];
		if (!scriptPaths.length) return;

		fs.mkdirSync(scriptsDir, { recursive: true });
		for (const scriptPath of scriptPaths) {
			const srcPath = path.join(vaultPath, scriptPath);
			if (!fs.existsSync(srcPath)) {
				new Notice(
					`⚠️ Custom script not found in vault: ${scriptPath}`,
				);
				continue;
			}
			// Strip any leading dot (e.g. a source path under ".obsidian/...")
			// — Vite's import.meta.glob excludes dotfiles by default, so a
			// flattened name starting with "." would silently never match
			// the "*.{js,ts}" pattern in +layout.svelte.
			const flatName = scriptPath.replace(/\//g, "__").replace(/^\.+/, "");
			fs.copyFileSync(srcPath, path.join(scriptsDir, flatName));
		}
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
		const saved = (await this.loadData()) as
			| Partial<SvelteExporterSettings>
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}
