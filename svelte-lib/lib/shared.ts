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

/** Forces as Obsidian's graph worker receives them — converted from
 * graph.json's slider positions by the plugin (computeGraphForces in
 * src/obsidianGraph.ts), applied by graphPhysics.ts. */
export interface GraphForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
}
