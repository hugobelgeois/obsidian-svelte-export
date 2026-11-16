/**
 * What the plugin (src/, bundled by esbuild) and the exported site (this
 * folder, built by Vite) must agree on — defined once, here: the plugin
 * imports this file directly. Keep it free of SvelteKit imports ($app/…,
 * $lib/…) and of anything browser- or Node-specific, so both can use it.
 */

/**
 * Placeholder prefix the plugin stamps onto every root-relative URL it
 * generates (internal link hrefs, image srcs, …) — swapped for the site's
 * real SvelteKit `base` path at render time by applyBase() in basePath.ts.
 * Routes are baked into the exported .svelte files at export time, long
 * before the SvelteKit build (and its `base` config) even exists, so this
 * placeholder is what lets the same generated markup work whether the site
 * is served at "/" or under a GitHub Pages-style "/<repo>/" subpath.
 */
export const BASE_PATH_SENTINEL = "%%BASE%%";

/** localStorage key of the visitor's own color mode choice — saved by
 * +layout.svelte, read by the script the plugin puts in app.html (see
 * patchAppHtml in src/siteFiles.ts) before the page is first painted. */
export const COLOR_MODE_KEY = "svelte-exporter-color-mode";

/** Whether path `p` is in `paths`, or under one of them — one lookup per
 * folder level of `p`, however many `paths` there are. Works on vault
 * paths ("A/B") and routes ("/A/B") alike. */
export function isWithinAny(p: string, paths: Set<string>): boolean {
	if (paths.has(p)) return true;
	for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
		if (paths.has(p.slice(0, i))) return true;
	}
	return false;
}

/** `route` with the trailing slash every note's route has on the site
 * (siteTree/Graph node ids, prerendered page URLs). */
export function withSlash(route: string): string {
	return route.endsWith("/") ? route : route + "/";
}

/** Strip diacritics (é→e, è→e, ç→c, …). */
export function stripDiacritics(str: string): string {
	return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** The first `max` characters of `text`, cut at a word boundary (when
 * there's one in its second half), "…" added if anything was cut — page
 * descriptions (plugin) and search result snippets (site). */
export function excerpt(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** A sort comparator ordering folders first, then files, each by name —
 * as a file explorer does (the settings tab's tree, the site's file tree). */
export function foldersFirst<T>(
	isFolder: (item: T) => boolean,
	name: (item: T) => string,
): (a: T, b: T) => number {
	return (a, b) => {
		const aFolder = isFolder(a);
		if (aFolder !== isFolder(b)) return aFolder ? -1 : 1;
		return name(a).localeCompare(name(b));
	};
}

/** Forces as Obsidian's graph worker receives them — converted from
 * graph.json's slider positions by the plugin (computeGraphForces in
 * src/obsidianGraph.ts), applied by graphPhysics.ts. */
export interface GraphForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
}
