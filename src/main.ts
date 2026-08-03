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
	 * selectAllDescendants/hideAllDescendants apply when the parent itself
	 * is toggled in settings.ts. Without this, a note dropped into an
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

		// Single source of truth for "which routes should exist right now" —
		// reused below both to prune stale src/routes/ directories and to
		// drop stale links.json entries for notes no longer exported.
		const expectedRoutes = new Set(
			files
				.filter((f) => f.extension === "md")
				.map((f) => "/" + sanitizeRoutePath(f.path)),
		);

		// A note deleted (or deselected) from the vault would otherwise keep
		// its previously exported route forever — nothing else ever removes
		// a src/routes/ leaf directory once written. Prune anything under
		// routes/ that doesn't correspond to a currently selected markdown
		// file before the export loop below writes/skips the current set.
		this.pruneStaleRoutes(
			destinationPath,
			new Set(
				[...expectedRoutes].map((route) =>
					path.join(destinationPath, "src", "routes", route),
				),
			),
		);

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
		// Drop link-graph entries for notes no longer part of the export
		// selection — otherwise a deleted/deselected note's stale entry (and
		// any dangling reference to it from a note that still links to it)
		// lingers in the Graph view forever.
		linksMap = Object.fromEntries(
			Object.entries(linksMap).filter(([route]) =>
				expectedRoutes.has(route),
			),
		);
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
		// Drop cache entries for files no longer part of the export
		// selection, so a re-selected/re-added file at the same vault path
		// re-exports fresh rather than immediately being cache-skipped
		// against a stale mtime.
		const currentFilePaths = new Set(files.map((f) => f.path));
		cache = Object.fromEntries(
			Object.entries(cache).filter(([p]) => currentFilePaths.has(p)),
		);

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
	 * Removes every src/routes/ leaf directory (one per exported markdown
	 * file, written by exportFile in pageexporter.ts) that isn't in
	 * `expectedDirs`, then cleans up any intermediate folder directory left
	 * empty by that removal. Only recurses into directories that AREN'T
	 * themselves a page leaf — a leaf dir (identified by containing
	 * +page.svelte) is a export target in its own right and never nests
	 * another one.
	 *
	 * Doesn't touch routesRoot's own direct +page.svelte/+page.ts (the
	 * site's root page, written by writeDefaultPage / scaffolded by
	 * ensureSvelteProject) since those are files, not directories, and this
	 * only ever iterates directories.
	 */
	private pruneStaleRoutes(
		destinationPath: string,
		expectedDirs: Set<string>,
	): void {
		const routesRoot = path.join(destinationPath, "src", "routes");
		if (!fs.existsSync(routesRoot)) return;

		const isPageDir = (dir: string) =>
			fs.existsSync(path.join(dir, "+page.svelte"));

		const walk = (dir: string): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const full = path.join(dir, entry.name);
				if (isPageDir(full)) {
					if (!expectedDirs.has(full)) {
						fs.rmSync(full, { recursive: true, force: true });
					}
					continue;
				}
				walk(full);
				if (fs.existsSync(full) && fs.readdirSync(full).length === 0) {
					fs.rmdirSync(full);
				}
			}
		};

		walk(routesRoot);
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
