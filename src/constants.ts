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
 * Sanitize a vault-relative path into a filesystem/URL-safe route path.
 * Strips the ".md" extension and replaces characters that would break
 * Node ESM module resolution (e.g. apostrophes) or URLs.
 *
 * Single source of truth — used by pageexporter.ts (route generation),
 * main.ts (nameMap.json) and siteTree.ts's mental model of route shape.
 */
export function sanitizeRoutePath(vaultPath: string): string {
	return vaultPath
		.replace(/\.md$/, "")
		.split("/")
		.map((seg) =>
			seg.replace(/['"]/g, "").replace(/[^a-zA-Z0-9_\-. ]/g, "_"),
		)
		.join("/");
}
