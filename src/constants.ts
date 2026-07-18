export const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"avif",
]);

/**
 * Placeholder prefix stamped onto every root-relative URL pageexporter.ts
 * generates (wikilink hrefs, image embed srcs, …) — swapped for the site's
 * real SvelteKit `base` path at runtime by svelte-lib/lib/markdownRenderer.ts.
 * Routes are baked into the exported .svelte files as plain string literals
 * at export time, long before the SvelteKit build (and its `base` config)
 * even exists, so this placeholder is what lets the same generated markup
 * work whether the site is served at "/" or under a GitHub Pages-style
 * "/<repo>/" subpath. Must stay byte-for-byte identical to BASE_SENTINEL in
 * markdownRenderer.ts (a separate module graph — Vite-bundled, not
 * esbuild-bundled with this file — so it can't just be imported here).
 */
export const BASE_PATH_SENTINEL = "%%BASE%%";

/** Strip diacritics (é→e, è→e, ç→c, …) instead of turning them into "_". */
function stripDiacritics(str: string): string {
	return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Sanitize a vault-relative path into a filesystem/URL-safe route path.
 * Strips the ".md" extension, transliterates accented characters to their
 * plain ASCII equivalent (so "Règles" → "Regles", not "R_gles"), and
 * replaces any remaining character that would break Node ESM module
 * resolution (e.g. apostrophes) or URLs.
 *
 * Single source of truth — used by pageexporter.ts (route generation),
 * main.ts (nameMap.json) and siteTree.ts's mental model of route shape.
 */
export function sanitizeRoutePath(vaultPath: string): string {
	return vaultPath
		.replace(/\.md$/, "")
		.split("/")
		.map((seg) =>
			stripDiacritics(seg)
				.replace(/['"]/g, "")
				.replace(/[^a-zA-Z0-9_\-. ]/g, "_"),
		)
		.join("/");
}
