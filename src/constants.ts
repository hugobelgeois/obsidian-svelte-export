export const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"avif",
]);

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
