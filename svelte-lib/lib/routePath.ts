import { base } from "$app/paths";

/**
 * Converts a browser pathname (from `$page.url.pathname`, which includes
 * the site's base path in production — e.g. "/aerethios/Notes/Arvens" on a
 * GitHub Pages project page) into the canonical base-less route path used
 * internally everywhere else (siteTree.ts's TreeNode.path, Graph.svelte's
 * node ids, hiddenPaths.ts, …). Without stripping `base` here, comparisons
 * like `node.path === currentPath` would never match once the site is
 * deployed under a subpath, even though everything works at "/" in dev.
 */
export function toRoutePath(pathname: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		decoded = pathname;
	}
	return decoded.startsWith(base) ? decoded.slice(base.length) || "/" : decoded;
}
