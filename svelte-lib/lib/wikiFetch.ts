/**
 * Shared logic for fetching a prerendered SvelteKit route and extracting
 * either the whole `.markdown-rendered` content or just a single heading's
 * section from it, for LinkPreview.svelte's hover panel.
 */
import { base } from "$app/paths";

/** Must stay identical to slugify() in the plugin's src/constants.ts, which
 * gave the headings their ids (separate module graph — can't import it). */
function slugify(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_-]/gu, "");
}

/**
 * Narrow `content` down to a single heading plus its following siblings,
 * up to (but excluding) the next heading of equal or higher level.
 * Returns null if the heading can't be found, so callers can fall back
 * to the full content.
 */
function extractFragment(content: Element, fragment: string): string | null {
	const decoded = decodeURIComponent(fragment);
	const slug = slugify(decoded);

	const heading =
		content.querySelector(`#${CSS.escape(slug)}`) ??
		[...content.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
			(el) =>
				el.id.toLowerCase() === slug.toLowerCase() ||
				el.textContent?.trim().toLowerCase() === decoded.toLowerCase(),
		) ??
		null;

	if (!heading) return null;

	// Obsidian's renderer wraps every block (heading, paragraph, list…) in
	// its own <div>, so the section is the heading's block plus the blocks
	// after it, up to the next one holding a heading of equal/higher level.
	let block: Element = heading;
	while (block.parentElement && block.parentElement !== content) {
		block = block.parentElement;
	}
	const headingLevel = (el: Element): number | null => {
		const h = el.matches(HEADING) ? el : el.querySelector(`:scope > ${HEADING}`);
		return h ? Number(h.tagName[1]) : null;
	};
	const level = Number(heading.tagName[1]);
	const parts: string[] = [block.outerHTML];
	for (let sib = block.nextElementSibling; sib; sib = sib.nextElementSibling) {
		const l = headingLevel(sib);
		if (l !== null && l <= level) break;
		parts.push(sib.outerHTML);
	}
	return parts.join("");
}

const HEADING = ":is(h1, h2, h3, h4, h5, h6)";

/** Route → its rendered content, fetched once per visit — whichever of
 * its headings a link points to. */
const contents = new Map<string, Promise<Element>>();

function fetchContent(route: string): Promise<Element> {
	let content = contents.get(route);
	if (!content) {
		content = loadContent(route);
		contents.set(route, content);
		// A failed fetch is retried next time instead of cached.
		content.catch(() => contents.delete(route));
	}
	return content;
}

async function loadContent(route: string): Promise<Element> {
	// `route` is the base-less canonical route (e.g. from data-wiki-href) —
	// add the site's real base ourselves, same as any other internal link.
	const fullRoute = base + route;
	const url = fullRoute.endsWith("/") ? fullRoute : fullRoute + "/";
	const res = await fetch(url, { headers: { Accept: "text/html" } });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const text = await res.text();

	const doc = new DOMParser().parseFromString(text, "text/html");
	const content =
		doc.querySelector(".markdown-rendered") ?? doc.querySelector("article");
	if (!content) throw new Error("selector not found");
	return content;
}

/**
 * Fetch a prerendered route and return the HTML of its rendered content,
 * narrowed to `fragment` (a heading) when one is given and found.
 * Throws on network/HTTP errors or if no renderable content is found —
 * callers are expected to catch and show an "unavailable" state.
 */
export async function fetchWikiHtml(
	route: string,
	fragment: string,
): Promise<string> {
	const content = await fetchContent(route);

	if (fragment) {
		const narrowed = extractFragment(content, fragment);
		if (narrowed) return narrowed;
	}

	return content.innerHTML;
}
