import { base } from "$app/paths";
import { BASE_PATH_SENTINEL } from "./shared";

/** Swaps BASE_PATH_SENTINEL — stamped by the plugin at export time, before
 * the site's real `base` path is known — for that base, at render time. */
export function applyBase(html: string): string {
	// A string pattern: the sentinel is matched literally. (A function
	// replacement, so a "$" in `base` isn't read as a replacement pattern.)
	return html.replaceAll(BASE_PATH_SENTINEL, () => base);
}
