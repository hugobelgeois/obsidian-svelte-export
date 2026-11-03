import * as fs from "fs";
import { moment, Notice, TFile } from "obsidian";
import * as path from "path";
import { routeOf } from "./constants";
import type { ExportContext } from "./exporter";
import { computeGraphForces, computeNodeColors } from "./obsidianGraph";
import type { ActiveCss } from "./obsidianCss";
import { writeJsonFile } from "./obsidianUtil";
import type { SiteInfo } from "./pageexporter";
import { computeStyleSettingsClasses } from "./styleSettings";
import { SyncedFolder } from "./syncedFolder";

/**
 * Everything an export writes into the SvelteKit project besides the notes'
 * own pages (pageexporter.ts) and the export's state files (exporter.ts):
 * the site's data files, root page, app.html tweaks, custom scripts, search
 * index and sitemap.
 */

/** Data files read by the site at build time (see svelte-lib/lib/exportData.ts).
 * Returns the Style Settings classes, which patchAppHtml() also needs. */
export function writeSiteData(
	ctx: ExportContext,
	files: TFile[],
	activeCss: ActiveCss,
	styleSettingsCss: string,
): string[] {
	const { app, settings, libDir, obsidianDir } = ctx;
	const writeLibJson = (name: string, data: unknown) =>
		writeJsonFile(path.join(libDir, name), data);

	writeLibJson("graphConfig.json", {
		animationType: settings.graphAnimationType,
		// Same physics settings as the vault's own graph view.
		forces: computeGraphForces(obsidianDir),
	});
	writeLibJson("themeConfig.json", {
		defaultColorMode: settings.defaultColorMode,
	});

	// ── styleSettingsClasses.json ───────────────────────────────────────
	// The community "Style Settings" plugin (if installed) applies things
	// like ITS Theme's alternate "TTRPG" color schemes by toggling CSS
	// classes on <body> at runtime — classes the exported site otherwise
	// has no way to know about, since they live in that plugin's own
	// data.json rather than in the theme CSS itself.
	const styleSettingsClasses = computeStyleSettingsClasses(
		obsidianDir,
		activeCss,
	);
	// Style Settings' variable-* values are gated behind this class.
	if (styleSettingsCss) {
		styleSettingsClasses.push("css-settings-manager");
	}
	writeLibJson("styleSettingsClasses.json", styleSettingsClasses);

	// ── nodeColors.json ─────────────────────────────────────────────────
	// Obsidian's own graph view "Groups" — colors notes matching a saved
	// query (e.g. path:Bestiaire). Reused here so the exported graph's
	// big view looks the same, without asking the user to redefine
	// groups a second time in this plugin's own settings.
	writeLibJson(
		"nodeColors.json",
		settings.exportGraphColors
			? computeNodeColors(app, obsidianDir, files)
			: {},
	);

	// ── hidden.json ─────────────────────────────────────────────────────
	// Same sanitization as each file's actual route, or a hidden path
	// with accents/special characters would never match the FileTree's.
	// Only the topmost hidden paths: the FileTree hides everything under
	// them anyway, and hiddenPaths lists every descendant of a hidden folder.
	writeLibJson(
		"hidden.json",
		topmostPaths(settings.hiddenPaths).map(routeOf),
	);

	// ── nameMap.json ────────────────────────────────────────────────────
	// Maps sanitized route path → original display name, so the FileTree
	// can show "Léoric" instead of "Leoric". This covers both leaf pages
	// (md files) AND every ancestor folder, so folder names in the tree
	// also keep their original spelling/accents instead of the
	// sanitized route segment.
	const nameMap: Record<string, string> = {};
	for (const file of files) {
		if (file.extension !== "md") continue;
		nameMap[routeOf(file.path)] = file.basename;

		let parent = file.parent;
		while (parent && parent.path && parent.path !== "/") {
			nameMap[routeOf(parent.path)] = parent.name;
			parent = parent.parent;
		}
	}
	writeLibJson("nameMap.json", nameMap);
	return styleSettingsClasses;
}

/**
 * The site's root page (src/routes/+page.svelte + +page.ts, keyed by path
 * relative to src/) according to the "Default page" setting — written by
 * ensureSvelteProject in place of svelte-lib/'s, and deleted by it once no
 * longer generated:
 * - "" (default): nothing — svelte-lib/routes/+page.svelte's welcome
 *   screen is used as-is.
 * - "__graph__": show the graph view as a normal full page, not a popup.
 * - anything else: a route path — redirect "/" to that note.
 */
export function defaultPageFiles(
	defaultPage: string,
	expectedRoutes: Set<string>,
): Record<string, string> {
	if (defaultPage === "") return {};

	if (defaultPage === "__graph__") {
		return {
			"routes/+page.svelte":
				'<script lang="ts">\n\timport Graph from "$lib/Graph.svelte";\n</script>\n\n<Graph standalone />\n',
			"routes/+page.ts":
				"export const prerender = true;\n\n" +
				"// Resolved before any component renders, so Body.svelte and\n" +
				"// +layout.svelte can size/lay out the page correctly on the very\n" +
				"// first (server-rendered) paint — unlike a store a child component\n" +
				"// would set too late. isGraphPage (distinct from fullBleed, which a\n" +
				"// full-width note also sets) is what tells +layout.svelte to hide\n" +
				"// the right sidebar's own redundant mini-graph on this route.\n" +
				"export const load = () => ({ fullBleed: true, isGraphPage: true });\n",
		};
	}

	// A specific note's route — but only redirect there if it's still
	// actually part of the current export selection; otherwise silently
	// fall back to the welcome screen rather than shipping a redirect
	// to a page that was never generated.
	if (!expectedRoutes.has(defaultPage)) return {};

	const target = defaultPage.endsWith("/") ? defaultPage : defaultPage + "/";
	return {
		"routes/+page.svelte": `<!-- Redirects to ${target} — see +page.ts -->\n`,
		"routes/+page.ts":
			'import { redirect } from "@sveltejs/kit";\n' +
			'import { base } from "$app/paths";\n\n' +
			"export const prerender = true;\n\n" +
			"export const load = () => {\n" +
			// `target` is base-less — the real site base (e.g. on a
			// GitHub Pages project page) has to be prepended, same as
			// any other internal link.
			`\tthrow redirect(307, base + ${JSON.stringify(target)});\n` +
			"};\n",
	};
}

const FAVICON_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Patches app.html — `sv create`'s, generated once and never touched
 * again by copyPluginFiles, so it's edited in place, on every export,
 * idempotently:
 * - <html lang>: the "Site language" setting, or Obsidian's own interface
 *   language by default;
 * - <link rel="icon">: the chosen favicon, copied into static/. Any icon
 *   link this previously added is stripped first, so switching images (or
 *   clearing the setting) never leaves a stale/duplicate tag behind;
 * - a script at the top of <body> (also replaced every time) giving it the
 *   color mode and Style Settings classes before anything is painted —
 *   added by +layout.svelte only once the page is hydrated, the prerendered
 *   page would otherwise first show up unthemed.
 */
export function patchAppHtml(
	ctx: ExportContext,
	staticFiles: SyncedFolder,
	bodyClasses: string[],
) {
	const appHtmlPath = path.join(ctx.destinationPath, "src", "app.html");
	if (!fs.existsSync(appHtmlPath)) return;
	const original = fs.readFileSync(appHtmlPath, "utf-8");

	const lang = ctx.settings.siteLanguage.trim() || moment.locale() || "en";
	let html = original.replace(/<html\b[^>]*>/, (tag) =>
		/\blang="[^"]*"/.test(tag)
			? tag.replace(/\blang="[^"]*"/, `lang="${lang}"`)
			: tag.replace("<html", `<html lang="${lang}"`),
	);

	html = html.replace(
		/[ \t]*<link rel="icon"[^>]*data-svelte-exporter-favicon[^>]*>\n?/,
		"",
	);
	const faviconPath = ctx.settings.faviconPath?.trim();
	if (faviconPath) {
		const srcPath = path.join(ctx.vaultPath, faviconPath);
		if (fs.existsSync(srcPath)) {
			const ext = path.extname(srcPath).toLowerCase() || ".png";
			staticFiles.copy(srcPath, `favicon${ext}`);
			const mime = FAVICON_MIME_TYPES[ext] ?? "image/png";
			// %sveltekit.assets% (not a hardcoded "/favicon...") — this
			// placeholder is filled in by SvelteKit itself with the
			// correct base-prefixed assets path, so the icon still
			// resolves under a GitHub Pages-style "/<repo>/" subpath.
			const tag =
				`\t\t<link rel="icon" href="%sveltekit.assets%/favicon${ext}" ` +
				`type="${mime}" data-svelte-exporter-favicon />\n`;
			html = html.replace("%sveltekit.head%", `${tag}\t\t%sveltekit.head%`);
		} else {
			new Notice(`⚠️ Favicon file not found in vault: ${faviconPath}`);
		}
	}

	html = html.replace(
		/[ \t]*<script data-svelte-exporter-theme>[\s\S]*?<\/script>\n?/,
		"",
	);
	html = html.replace(
		/<body\b[^>]*>\n?/,
		(tag) => `${tag}${themeScript(ctx.settings.defaultColorMode, bodyClasses)}`,
	);

	if (html !== original) fs.writeFileSync(appHtmlPath, html, "utf-8");
}

/** Must match COLOR_MODE_KEY in svelte-lib/routes/+layout.svelte. */
const COLOR_MODE_KEY = "svelte-exporter-color-mode";

/** The inline <body> script of patchAppHtml(): the visitor's saved color
 * mode (see toggleTheme in +layout.svelte), or the default one. */
function themeScript(defaultMode: "dark" | "light", classes: string[]): string {
	// "<" escaped so no value can close the <script> early.
	const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
	return (
		"\t\t<script data-svelte-exporter-theme>\n" +
		"\t\t\t(function () {\n" +
		`\t\t\t\tvar mode = ${json(defaultMode)};\n` +
		"\t\t\t\ttry {\n" +
		`\t\t\t\t\tvar saved = localStorage.getItem(${json(COLOR_MODE_KEY)});\n` +
		'\t\t\t\t\tif (saved === "dark" || saved === "light") mode = saved;\n' +
		"\t\t\t\t} catch (e) {}\n" +
		`\t\t\t\tdocument.body.classList.add.apply(document.body.classList, ${json(classes)}.concat("theme-" + mode));\n` +
		"\t\t\t})();\n" +
		"\t\t</script>\n"
	);
}

/**
 * Copies every file in customScriptPaths into src/lib/customScripts/ —
 * picked up at build time by the import.meta.glob() call in
 * svelte-lib/routes/+layout.svelte, which awaits each module after the
 * page mounts and calls its default export (if it's a function). The
 * folder is synced, so a script removed from settings doesn't linger in the
 * exported project, and an unchanged one isn't rewritten. Subfolders are
 * flattened into the filename (e.g. "scripts/foo.ts" → "scripts__foo.ts")
 * so two files with the same basename in different vault folders can't
 * collide once copied flat.
 */
export function writeCustomScripts(ctx: ExportContext) {
	const scripts = new SyncedFolder(path.join(ctx.libDir, "customScripts"));
	for (const scriptPath of ctx.settings.customScriptPaths) {
		const srcPath = path.join(ctx.vaultPath, scriptPath);
		if (!fs.existsSync(srcPath)) {
			new Notice(`⚠️ Custom script not found in vault: ${scriptPath}`);
			continue;
		}
		// Strip any leading dot (e.g. a source path under ".obsidian/...")
		// — Vite's import.meta.glob excludes dotfiles by default, so a
		// flattened name starting with "." would silently never match
		// the "*.{js,ts}" pattern in +layout.svelte.
		const flatName = scriptPath.replace(/\//g, "__").replace(/^\.+/, "");
		scripts.copy(srcPath, flatName);
	}
	scripts.prune();
}

/** Whether `p` is `ancestor` itself or somewhere under it. */
function isWithin(p: string, ancestor: string): boolean {
	return p === ancestor || p.startsWith(ancestor + "/");
}

/** `paths` without those under another one of them. */
export function topmostPaths(paths: string[]): string[] {
	const sorted = [...new Set(paths)].sort();
	const result: string[] = [];
	for (const p of sorted) {
		// Sorted, so an ancestor comes before everything under it — though
		// not always right before ("A" < "A b" < "A/c"), hence some().
		if (!result.some((r) => isWithin(p, r))) result.push(p);
	}
	return result;
}

/** Notes the site lists (file tree, search, sitemap): exported, and
 * not hidden from the file tree themselves or through a folder. */
export function listedNotes(files: TFile[], hiddenPaths: string[]): TFile[] {
	const hidden = topmostPaths(hiddenPaths);
	return files.filter(
		(f) => f.extension === "md" && !hidden.some((h) => isWithin(f.path, h)),
	);
}

/**
 * static/search.json — every listed note's route, name and text, fetched
 * by the site's search box (svelte-lib/lib/SearchResults.svelte) the
 * first time a visitor searches.
 */
export function writeSearchIndex(
	staticFiles: SyncedFolder,
	notes: TFile[],
	searchText: Record<string, string>,
) {
	const entries = notes.map((f) => ({
		route: routeOf(f.path),
		title: f.basename,
		text: searchText[f.path] ?? "",
	}));
	staticFiles.write("search.json", JSON.stringify(entries));
}

/**
 * static/sitemap.xml + robots.txt pointing to it, for search engines —
 * only when the site's public URL is set, since a sitemap must list
 * absolute URLs.
 */
export function writeSitemap(
	staticFiles: SyncedFolder,
	notes: TFile[],
	site: SiteInfo,
) {
	if (!site.url) return;
	const escapeXml = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const url = (route: string, lastmod?: number) =>
		`  <url><loc>${escapeXml(site.url + encodeURI(route))}</loc>` +
		(lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "") +
		`</url>`;
	const urls = [
		url("/"),
		...notes.map((f) => url(routeOf(f.path) + "/", f.stat.mtime)),
	];
	staticFiles.write(
		"sitemap.xml",
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
			`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
			`${urls.join("\n")}\n</urlset>\n`,
	);
	staticFiles.write(
		"robots.txt",
		`User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`,
	);
}
