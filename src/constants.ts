import { BASE_PATH_SENTINEL } from "../svelte-lib/lib/shared";

export const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"avif",
]);

/** Whether the export handles `file` at all: notes and images. */
export function isExportable(file: { extension: string }): boolean {
	return file.extension === "md" || IMAGE_EXTENSIONS.has(file.extension);
}

/** Whether vault path `p` is `ancestor` itself or somewhere under it. */
export function isWithin(p: string, ancestor: string): boolean {
	return p === ancestor || p.startsWith(ancestor + "/");
}

/** Whether vault path `p` is in `paths`, or under one of them — one lookup
 * per folder level of `p`, however many `paths` there are. */
export function isWithinAny(p: string, paths: Set<string>): boolean {
	if (paths.has(p)) return true;
	for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
		if (paths.has(p.slice(0, i))) return true;
	}
	return false;
}

/** File extension → MIME type, for the files an export serves or inlines. */
const MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	woff2: "font/woff2",
	woff: "font/woff",
	ttf: "font/ttf",
	otf: "font/otf",
};

/** The MIME type of a file name/path/URL by its extension (query string
 * and fragment ignored) — undefined if unknown. */
export function mimeTypeOf(name: string): string | undefined {
	const file = name.split(/[?#]/)[0] ?? "";
	const dot = file.lastIndexOf(".");
	return dot === -1 ? undefined : MIME_TYPES[file.slice(dot + 1).toLowerCase()];
}

// Shared with the exported site — defined once, in svelte-lib/lib/shared.ts.
export { BASE_PATH_SENTINEL, COLOR_MODE_KEY } from "../svelte-lib/lib/shared";

/** Strip diacritics (é→e, è→e, ç→c, …). */
export function stripDiacritics(str: string): string {
	return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Slugify arbitrary text into a URL/id-safe token (heading ids). Accents
 * are transliterated ("Légendes" → "legendes", not "lgendes") and letters
 * of any script are kept, so a heading written entirely in, say, Cyrillic
 * doesn't end up with an empty id. Only the plugin needs it: links are
 * resolved to their target's exact id at export time (see anchorId in
 * noteRenderer.ts), so the site never slugifies anything itself.
 */
export function slugify(text: string): string {
	return stripDiacritics(text)
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_-]/gu, "");
}

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

/** The URL path of a note's page on the site, base-less: its route plus
 * the trailing slash every page has there ("Règles/Été.md" → "/Regles/Ete/")
 * — also the graph's node ids. */
export function pageRouteOf(vaultPath: string): string {
	return routeOf(vaultPath) + "/";
}
