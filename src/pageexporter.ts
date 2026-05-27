import * as fs from "fs";
import { TFile, Vault } from "obsidian";
import * as path from "path";

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a vault markdown file, convert it to a SvelteKit page pair
 * (`+page.svelte` + `+page.ts`) and write them under `destRoot/src/routes/`.
 */
export async function exportFile(
	file: TFile,
	destRoot: string,
	vault: Vault,
): Promise<void> {
	const markdown = await vault.read(file);

	// Build a map of basename → route path for all markdown files in the vault,
	// used to resolve [[wikilinks]] to their actual SvelteKit route.
	const wikilinkMap = buildWikilinkMap(vault);

	const { pageSvelte, pageTs } = markdownToSvelte(
		markdown,
		file.basename,
		wikilinkMap,
	);

	const outputDir = path.join(
		destRoot,
		"src",
		"routes",
		file.path.replace(/\.md$/, ""),
	);

	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	fs.writeFileSync(path.join(outputDir, "+page.svelte"), pageSvelte, "utf-8");
	fs.writeFileSync(path.join(outputDir, "+page.ts"), pageTs, "utf-8");
}

// ── Wikilink map ───────────────────────────────────────────────────────────

/**
 * Returns a map of { basename_lowercase → route_path } for every .md file
 * in the vault, so [[Note Name]] can be resolved to its URL.
 */
function buildWikilinkMap(vault: Vault): Map<string, string> {
	const map = new Map<string, string>();
	for (const file of vault.getMarkdownFiles()) {
		const route = "/" + file.path.replace(/\.md$/, "");
		map.set(file.basename.toLowerCase(), route);
	}
	return map;
}

/**
 * Resolve an Obsidian wikilink target to { route, fragment }.
 * Returns null if the note is not found in the vault.
 */
function resolveWikilink(
	target: string,
	wikilinkMap: Map<string, string>,
): { route: string; fragment: string } | null {
	const hashIdx = target.indexOf("#");
	const notePart =
		hashIdx === -1 ? target.trim() : target.slice(0, hashIdx).trim();
	const fragment = hashIdx === -1 ? "" : target.slice(hashIdx + 1).trim();
	const route = wikilinkMap.get(notePart.toLowerCase());
	if (!route) return null;
	return { route, fragment };
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]/g, "");
}

// ── Markdown → Svelte page pair ────────────────────────────────────────────

interface PageFiles {
	pageSvelte: string;
	pageTs: string;
}

function markdownToSvelte(
	markdown: string,
	title: string,
	wikilinkMap: Map<string, string>,
): PageFiles {
	const frontMatter: Record<string, string> = {};
	const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (fmMatch) {
		fmMatch[1].split("\n").forEach((line) => {
			const idx = line.indexOf(":");
			if (idx !== -1) {
				frontMatter[line.slice(0, idx).trim()] = line
					.slice(idx + 1)
					.trim();
			}
		});
	}

	const pageTitle = frontMatter["title"] || title;
	const pageDescription = frontMatter["description"] || "";

	const processedMarkdown = processWikilinks(markdown, wikilinkMap);

	const pageTs = `import { renderMarkdown } from "$lib/markdownRenderer";
import type { PageLoad } from "./$types";

const rawMarkdown: string = ${JSON.stringify(processedMarkdown)};

export const load: PageLoad = () => ({
  html: renderMarkdown(rawMarkdown),
  pageTitle: ${JSON.stringify(pageTitle)},
  pageDescription: ${JSON.stringify(pageDescription)},
});
`;

	const pageSvelte = `<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { mount } from "svelte";
  import { tocHeadings } from "$lib/stores";
  import LinkPreview from "$lib/LinkPreview.svelte";
  import EmbedBlock from "$lib/EmbedBlock.svelte";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();

  let embeds: Array<ReturnType<typeof mount>> = [];

  onMount(() => {
    // ── TOC headings ──────────────────────────────────────────────────
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".md-content h1, .md-content h2, .md-content h3, .md-content h4"
      )
    );
    tocHeadings.set(
      els.map((el) => ({
        id: el.id,
        text: el.textContent ?? "",
        level: parseInt(el.tagName[1]),
      }))
    );

    // ── Mount EmbedBlock into ![[]] placeholders ───────────────────────
    const containers = document.querySelectorAll<HTMLElement>(".wiki-embed[data-route]");
    for (const container of containers) {
      const route = decodeURIComponent(container.dataset.route ?? "");
      const fragment = decodeURIComponent(container.dataset.fragment ?? "");
      const instance = mount(EmbedBlock, { target: container, props: { route, fragment } });
      embeds.push(instance);
    }
  });

  onDestroy(() => {
    tocHeadings.set([]);
    for (const instance of embeds) {
      try { (instance as any).$destroy?.(); } catch { /* ignore */ }
    }
  });
</script>

<svelte:head>
  <title>{data.pageTitle}</title>
  {#if data.pageDescription}
    <meta name="description" content={data.pageDescription} />
  {/if}
</svelte:head>

<article class="md-page">
  <header class="md-header">
    <h1>{data.pageTitle}</h1>
    {#if data.pageDescription}
      <p class="description">{data.pageDescription}</p>
    {/if}
  </header>
  <div class="md-content">
    {@html data.html}
  </div>
</article>

<LinkPreview />
`;

	return { pageSvelte, pageTs };
}

// ── Wikilink pre-processor ─────────────────────────────────────────────────

/**
 * Transform Obsidian wikilinks before markdown rendering.
 *
 * Strategy: replace each wikilink with a placeholder token that encodes
 * the final HTML as base64 inside the token itself. The markdown renderer
 * sees only alphanumeric characters and leaves the token untouched.
 * After rendering, restoreWikilinks decodes the tokens back to real HTML.
 *
 * This survives the plugin (Node.js) → exported site (browser) boundary
 * because the encoded HTML is embedded in the generated +page.ts string.
 *
 * ![[Note]]  / ![[Note#Section]]
 *   → <div class="wiki-embed" data-route="..." data-fragment="..."></div>
 *
 * [[Note]]   / [[Note#Section]]  / [[Note|alias]]
 *   → <a href="..." class="wiki-link internal-link" ...>label</a>
 *
 * Unresolved → <span class="wiki-unresolved">
 */
function processWikilinks(
	markdown: string,
	wikilinkMap: Map<string, string>,
): string {
	const encode = (html: string): string =>
		// base64url-safe: only [A-Za-z0-9+/=] — no markdown-special chars
		Buffer.from(html, "utf-8").toString("base64");

	const placeholder = (html: string): string =>
		`WIKISTART${encode(html)}WIKIEND`;

	// Embeds first (more specific — starts with !)
	markdown = markdown.replace(
		/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
		(_, target: string) => {
			const resolved = resolveWikilink(target, wikilinkMap);
			if (!resolved) {
				const noteName = target.split("#")[0].trim();
				return placeholder(
					`<span class="wiki-embed wiki-unresolved">${noteName}</span>`,
				);
			}
			const { route, fragment } = resolved;
			return placeholder(
				`<div class="wiki-embed" data-route="${encodeURIComponent(route)}" data-fragment="${encodeURIComponent(fragment)}"></div>`,
			);
		},
	);

	// Plain links
	markdown = markdown.replace(
		/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
		(_, target: string, alias: string | undefined) => {
			const resolved = resolveWikilink(target, wikilinkMap);
			const noteName = target.split("#")[0].trim();
			const label = alias?.trim() || noteName;
			if (!resolved) {
				return placeholder(
					`<span class="wiki-link wiki-unresolved">${label}</span>`,
				);
			}
			const { route, fragment } = resolved;
			const href = fragment ? `${route}#${slugify(fragment)}` : route;
			return placeholder(
				`<a href="${href}" class="wiki-link internal-link" data-wiki-href="${route}" data-wiki-fragment="${encodeURIComponent(fragment)}">${label}</a>`,
			);
		},
	);

	return markdown;
}
