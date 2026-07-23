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
 * Extensions exported the same way as images: selectable in the settings
 * tree, copied flat into static/ by basename. Covers arbitrary data a note
 * or a third-party plugin wants fetch()able at a predictable root-relative
 * URL (e.g. Map Manager's own JSON snapshots) — this exporter doesn't
 * inspect or care about the file's contents, just its extension.
 */
export const STATIC_PASSTHROUGH_EXTENSIONS = new Set([
	...IMAGE_EXTENSIONS,
	"json",
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

/** Slugify arbitrary text into a URL/id-safe token (heading ids, link fragments). */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]/g, "");
}

const ANCHOR_RE = /<a\b([^>]*)>/g;
const HREF_RE = /href="(\/[^"#]*)(#[^"]*)?"/;

function sanitizeHref(
	rawPath: string,
	rawFragment: string | undefined,
): string {
	let decodedPath = rawPath;
	try {
		decodedPath = decodeURIComponent(rawPath);
	} catch {
		// leave as-is if it isn't validly percent-encoded
	}
	const sanitizedPath = sanitizeRoutePath(decodedPath.replace(/^\//, ""));

	let fragment = "";
	if (rawFragment) {
		let decodedFragment = rawFragment.slice(1);
		try {
			decodedFragment = decodeURIComponent(decodedFragment);
		} catch {
			// leave as-is if it isn't validly percent-encoded
		}
		fragment = "#" + slugify(decodedFragment);
	}

	return `href="/${sanitizedPath}${fragment}"`;
}

/**
 * Rewrites root-relative href="/..." links on <a> tags embedded anywhere in
 * a JSON string — e.g. Map Manager's pre-rendered note HTML — so their path
 * segments and #fragment match the sanitized routes/heading ids this
 * exporter actually produces (same accent-stripping as sanitizeRoutePath,
 * same slugify() pageexporter.ts uses for heading ids), instead of the raw,
 * accented URLs Obsidian's own renderer baked into that HTML. Also strips
 * target="_blank" from those same tags — Obsidian opens internal links in a
 * new tab, but once the href resolves to a real route on this site it
 * should navigate in place like any other internal link.
 *
 * Deliberately narrow: it only touches <a> tags whose href is a root-
 * relative link, never other strings. Map Manager keys its own
 * tabs[].link fields into a notes{} lookup table using the untouched raw
 * vault path (see WorldMap.json) — rewriting those would break that
 * lookup, which is exactly what happened the first time this function
 * rewrote whole strings instead of just anchor tags.
 */
export function sanitizeJsonHtmlLinks(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(ANCHOR_RE, (fullTag, attrs: string) => {
			const hrefMatch = attrs.match(HREF_RE);
			if (!hrefMatch) return fullTag;

			const newHref = sanitizeHref(hrefMatch[1] ?? "", hrefMatch[2]);
			const newAttrs = attrs
				.replace(hrefMatch[0], newHref)
				.replace(/\s*target="_blank"/, "");

			return `<a${newAttrs}>`;
		});
	}
	if (Array.isArray(value)) return value.map(sanitizeJsonHtmlLinks);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = sanitizeJsonHtmlLinks(v);
		}
		return out;
	}
	return value;
}
