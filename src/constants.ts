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
 * Placeholder prefix stamped onto every root-relative URL noteRenderer.ts
 * generates (internal link hrefs, image srcs, …) — swapped for the site's
 * real SvelteKit `base` path at runtime by svelte-lib/lib/basePath.ts.
 * Routes are baked into the exported .svelte files as plain string literals
 * at export time, long before the SvelteKit build (and its `base` config)
 * even exists, so this placeholder is what lets the same generated markup
 * work whether the site is served at "/" or under a GitHub Pages-style
 * "/<repo>/" subpath. Must stay byte-for-byte identical to BASE_SENTINEL in
 * basePath.ts (a separate module graph — Vite-bundled, not
 * esbuild-bundled with this file — so it can't just be imported here).
 */
export const BASE_PATH_SENTINEL = "%%BASE%%";

/**
 * Where a vault file (image, …) is served on the site, relative to its
 * root: its own vault path, so two files with the same name in different
 * folders can't overwrite each other. A segment's leading dot becomes "_"
 * — dot-folders (e.g. .obsidian/) aren't served by Vite's dev server.
 */
export function staticFilePath(vaultRelativePath: string): string {
	return vaultRelativePath
		.replace(/\\/g, "/")
		.split("/")
		.filter(Boolean)
		.map((seg) => seg.replace(/^\./, "_"))
		.join("/");
}

/** Site URL (base-path sentinel included) of a file at staticFilePath(). */
export function staticFileUrl(vaultRelativePath: string): string {
	return (
		BASE_PATH_SENTINEL +
		"/" +
		staticFilePath(vaultRelativePath)
			.split("/")
			.map(encodeURIComponent)
			.join("/")
	);
}

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
 * siteFiles.ts (nameMap.json) and siteTree.ts's mental model of route shape.
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

/** The site route of a vault note or folder ("Règles/Été.md" → "/Regles/Ete"),
 * without the trailing slash the site adds. */
export function routeOf(vaultPath: string): string {
	return "/" + sanitizeRoutePath(vaultPath);
}

/**
 * Slugify arbitrary text into a URL/id-safe token (heading ids, link
 * fragments). Accents are transliterated ("Légendes" → "legendes", not
 * "lgendes") and letters of any script are kept, so a heading written
 * entirely in, say, Cyrillic doesn't end up with an empty id. Must stay
 * identical to slugify() in svelte-lib/lib/wikiFetch.ts.
 */
export function slugify(text: string): string {
	return stripDiacritics(text)
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_-]/gu, "");
}
