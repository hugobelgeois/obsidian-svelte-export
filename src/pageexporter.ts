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
	const { pageSvelte, pageTs } = markdownToSvelte(markdown, file.basename);

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

// ── Markdown → Svelte page pair ────────────────────────────────────────────

interface PageFiles {
	pageSvelte: string;
	pageTs: string;
}

function markdownToSvelte(markdown: string, title: string): PageFiles {
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

	// Markdown is embedded as a JSON string — no escaping issues, no backtick collisions
	const pageTs = `import { renderMarkdown } from "$lib/markdownRenderer";
import type { PageLoad } from "./$types";

const rawMarkdown: string = ${JSON.stringify(markdown)};

export const load: PageLoad = () => ({
  html: renderMarkdown(rawMarkdown),
  pageTitle: ${JSON.stringify(pageTitle)},
  pageDescription: ${JSON.stringify(pageDescription)},
});
`;

	const pageSvelte = `<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { tocHeadings } from "$lib/stores";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();

  onMount(() => {
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
  });

  onDestroy(() => tocHeadings.set([]));
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
`;

	return { pageSvelte, pageTs };
}
