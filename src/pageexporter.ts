import { App, TFile } from "obsidian";
import { BASE_PATH_SENTINEL, routeOf, sanitizeRoutePath } from "./constants";
import { NoteRenderer, RenderedNote } from "./noteRenderer";
import type { SyncedFolder } from "./syncedFolder";

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Bumped whenever the generated pages change in a way that requires the
 * matching svelte-lib/ files (e.g. a renamed import) — every cached page is
 * then regenerated on the next export instead of being skipped.
 */
export const PAGE_FORMAT_VERSION = 7;

export type ExportResult = Pick<
	RenderedNote,
	"linkedRoutes" | "assets" | "cssIds" | "pluginIds" | "deps" | "text"
>;

/** Site-wide details every page's sharing metadata (OpenGraph) uses. */
export interface SiteInfo {
	/** Public URL of the site's root, no trailing slash — "" if unknown,
	 * which leaves out everything that needs an absolute URL. */
	url: string;
	name: string;
}

/**
 * Renders `file` with Obsidian's own renderer (see noteRenderer.ts) and
 * writes it as src/routes/<route>/+page.svelte + +page.ts.
 */
export async function exportFile(
	file: TFile,
	pages: SyncedFolder,
	app: App,
	renderer: NoteRenderer,
	site: SiteInfo,
): Promise<ExportResult> {
	const markdown = await app.vault.read(file);
	// Obsidian's own front-matter parsing (real YAML: quoted strings,
	// lists, booleans…) — the body starts right after its closing "---".
	const cache = app.metadataCache.getFileCache(file);
	const meta: Record<string, unknown> = cache?.frontmatter ?? {};
	const fmEnd = cache?.frontmatterPosition?.end.offset;
	const body =
		fmEnd === undefined ? markdown : markdown.slice(fmEnd).replace(/^\r?\n/, "");

	const rendered = await renderer.render(file, body);
	const { pageSvelte, pageTs } = noteToSvelte(
		meta,
		file,
		rendered,
		site,
	);

	// A note re-rendered because something it depends on changed often
	// comes out the same — left untouched then.
	const [svelteFile, tsFile] = pageFiles(file.path);
	pages.write(svelteFile, pageSvelte);
	pages.write(tsFile, pageTs);

	const { linkedRoutes, assets, cssIds, pluginIds, deps, text } = rendered;
	return { linkedRoutes, assets, cssIds, pluginIds, deps, text };
}

/**
 * The page files of the note at `vaultPath`, relative to src/routes/.
 * Path segments are sanitized — apostrophes and other special chars break
 * Node ESM module resolution when SvelteKit imports the compiled route.
 */
export function pageFiles(vaultPath: string): [string, string] {
	const dir = sanitizeRoutePath(vaultPath);
	return [`${dir}/+page.svelte`, `${dir}/+page.ts`];
}

/** Whether a file in src/routes/ (path relative to it) is a note's page —
 * not the site's root page or layout, nor anything else in there. */
export function isNotePage(rel: string): boolean {
	return /.\/\+page\.(svelte|ts)$/.test(rel);
}

// ── Page template ──────────────────────────────────────────────────────────

/**
 * Svelte markup injecting ready-made `html` as-is. Internal links/images in
 * it carry BASE_PATH_SENTINEL (the site's base path isn't known yet at
 * export time), swapped for the real one by applyBase() when the page
 * renders — skipped altogether when there's nothing to swap.
 */
function htmlExpr(html: string): string {
	const literal = JSON.stringify(html);
	return html.includes(BASE_PATH_SENTINEL)
		? `{@html applyBase(${literal})}`
		: `{@html ${literal}}`;
}

/** The first `max` characters of `text`, cut at a word boundary. */
function excerpt(text: string, max = 200): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** A <meta> tag; `content` is plain text, emitted as a Svelte expression. */
function metaTag(attr: "name" | "property", key: string, content: string) {
	return `\n  <meta ${attr}="${key}" content={${JSON.stringify(content)}} />`;
}

/**
 * Description and sharing metadata (OpenGraph — the preview card Discord,
 * social networks… show for a link). og:url and og:image need the site's
 * public URL, so they're only there when it's set.
 */
function headMetadata(
	file: TFile,
	title: string,
	description: string,
	rendered: RenderedNote,
	site: SiteInfo,
): string {
	const summary = description || excerpt(rendered.text);
	let tags = "";
	if (summary) tags += metaTag("name", "description", summary);
	tags += metaTag("property", "og:type", "article");
	tags += metaTag("property", "og:title", title);
	if (summary) tags += metaTag("property", "og:description", summary);
	if (site.name) tags += metaTag("property", "og:site_name", site.name);
	if (site.url) {
		const route = routeOf(file.path) + "/";
		tags += metaTag("property", "og:url", site.url + encodeURI(route));
		if (rendered.image) {
			const image =
				site.url + rendered.image.slice(BASE_PATH_SENTINEL.length);
			tags += metaTag("property", "og:image", image);
		}
	}
	tags += metaTag(
		"name",
		"twitter:card",
		site.url && rendered.image ? "summary_large_image" : "summary",
	);
	return tags;
}

function noteToSvelte(
	meta: Record<string, unknown>,
	file: TFile,
	rendered: RenderedNote,
	site: SiteInfo,
): { pageSvelte: string; pageTs: string } {
	const text = (key: string) => {
		const v = meta[key];
		return typeof v === "string" || typeof v === "number" ? String(v) : "";
	};
	const pageTitle = text("title") || file.basename;
	const pageDescription = text("description");
	const flag = (key: string) =>
		meta[key] === true || text(key).trim().toLowerCase() === "true";
	const isFullWidth = flag("full-width");
	const isFullHeight = flag("full-height");
	const isHideTitle = flag("hide-title");
	// Front matter/filenames are plain text: emitted as Svelte expressions,
	// not raw markup, so a "{" or "<" can't break the generated page.
	const titleExpr = `{${JSON.stringify(pageTitle)}}`;
	const descriptionExpr = `{${JSON.stringify(pageDescription)}}`;

	// Written by writePluginCss() in exporter.ts — imported only by the pages
	// that need it, since a plugin's stylesheet can be large.
	const cssImports = rendered.cssIds
		.map((id) => `\n  import "$lib/pluginCss/${id}.css";`)
		.join("");

	// `title` still goes in <svelte:head> regardless — the browser tab and
	// SEO description shouldn't disappear just because the on-page heading
	// (the h1 a reader sees) is hidden via `hide-title`.
	const headerBlock = isHideTitle
		? ""
		: `  <header class="md-header">
    <h1>${titleExpr}</h1>${pageDescription ? `\n    <p class="description">${descriptionExpr}</p>` : ""}
  </header>
`;

	const pageSvelte = `<script lang="ts">
  import { applyBase } from "$lib/basePath";${cssImports}
</script>

<svelte:head>
  <title>${titleExpr}</title>${headMetadata(file, pageTitle, pageDescription, rendered, site)}
</svelte:head>

<article class="md-page">
${headerBlock}  <div class="markdown-rendered">
    ${htmlExpr(rendered.html)}
  </div>
</article>
`;

	// The headings go through load() (read by Toc.svelte from the page
	// data) rather than a store the page sets: page data is resolved before
	// anything renders, so it can't depend on which page mounts or unmounts
	// first during a navigation.
	const pageTs = `import type { PageLoad } from "./$types";

export const prerender = true;

export const load: PageLoad = () => ({
  pageTitle: ${JSON.stringify(pageTitle)},
  pageDescription: ${JSON.stringify(pageDescription)},
  fullBleed: ${isFullWidth},
  fullHeight: ${isFullHeight},
  headings: ${JSON.stringify(rendered.headings, null, 2).replace(/\n/g, "\n  ")},
});
`;

	return { pageSvelte, pageTs };
}
