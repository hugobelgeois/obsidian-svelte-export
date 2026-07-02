/**
 * Shared logic for fetching a prerendered SvelteKit route and extracting
 * either the whole `.markdown-rendered` content or just a single heading's
 * section from it. Used by both LinkPreview.svelte (hover panel) and
 * EmbedBlock.svelte (inline embeds) — previously duplicated in both files.
 */

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]/g, "");
}

/** Rewrite root-relative image URLs to absolute ones (safe to reuse HTML from another page). */
function absolutizeImages(root: Element): void {
	root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
		const src = img.getAttribute("src");
		if (src && src.startsWith("/")) {
			img.setAttribute("src", window.location.origin + src);
		}
	});
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
		content.querySelector(`[id="${slug}"]`) ??
		[...content.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
			(el) =>
				el.id.toLowerCase() === slug.toLowerCase() ||
				el.textContent?.trim().toLowerCase() === decoded.toLowerCase(),
		) ??
		null;

	if (!heading) return null;

	const level = parseInt(heading.tagName[1]);
	const parts: string[] = [heading.outerHTML];
	let sib = heading.nextElementSibling;
	while (sib) {
		if (sib.tagName.match(/^H[1-6]$/) && parseInt(sib.tagName[1]) <= level)
			break;
		parts.push(sib.outerHTML);
		sib = sib.nextElementSibling;
	}
	return parts.join("");
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
	const url = route.endsWith("/") ? route : route + "/";
	const res = await fetch(url, { headers: { Accept: "text/html" } });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const text = await res.text();

	const doc = new DOMParser().parseFromString(text, "text/html");
	const content =
		doc.querySelector(".markdown-rendered") ?? doc.querySelector("article");
	if (!content) throw new Error("selector not found");

	absolutizeImages(content);

	if (fragment) {
		const narrowed = extractFragment(content, fragment);
		if (narrowed) return narrowed;
	}

	return content.innerHTML;
}
