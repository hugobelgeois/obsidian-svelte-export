import { base } from "$app/paths";
import { BASE_PATH_SENTINEL } from "./shared";

/** Swaps BASE_PATH_SENTINEL — stamped by the plugin at export time, before
 * the site's real `base` path is known — for that base, at render time. */
export function applyBase(html: string): string {
	// split/join instead of a regex replace — the sentinel is a plain
	// literal string, never a pattern, and this can't misfire on any
	// regex-special characters `base` itself might contain.
	return html.split(BASE_PATH_SENTINEL).join(base);
}
