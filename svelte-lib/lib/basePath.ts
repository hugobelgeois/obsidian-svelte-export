import { base } from "$app/paths";

/**
 * Must stay byte-for-byte identical to BASE_PATH_SENTINEL in the plugin's
 * src/constants.ts (a separate, esbuild-bundled module graph — this file
 * lives in the exported SvelteKit project instead and can't import it
 * directly). The plugin stamps every internal route/image URL in the HTML
 * it generates with this placeholder at export time, before the site's
 * real `base` path is known.
 */
const BASE_SENTINEL = "%%BASE%%";

/** Swaps BASE_SENTINEL for the site's real base path, at render time. */
export function applyBase(html: string): string {
	// split/join instead of a regex replace — the sentinel is a plain
	// literal string, never a pattern, and this can't misfire on any
	// regex-special characters `base` itself might contain.
	return html.split(BASE_SENTINEL).join(base);
}
