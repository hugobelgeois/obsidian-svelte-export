import * as fs from "fs";
import { TFile, Vault } from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS, sanitizeRoutePath } from "./constants";

// ── Public API ─────────────────────────────────────────────────────────────

export async function exportFile(
	file: TFile,
	destRoot: string,
	vault: Vault,
): Promise<string[]> {
	const markdown = await vault.read(file);
	const wikilinkMap = buildWikilinkMap(vault);
	const { pageSvelte, pageTs, linkedRoutes } = markdownToSvelte(
		markdown,
		file.basename,
		wikilinkMap,
	);

	// Sanitize path segments — apostrophes and other special chars break
	// Node ESM module resolution when SvelteKit imports the compiled route.
	const sanitizedPath = sanitizeRoutePath(file.path);

	const outputDir = path.join(destRoot, "src", "routes", sanitizedPath);

	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	fs.writeFileSync(path.join(outputDir, "+page.svelte"), pageSvelte, "utf-8");
	fs.writeFileSync(path.join(outputDir, "+page.ts"), pageTs, "utf-8");

	return linkedRoutes;
}

// ── Wikilink helpers ───────────────────────────────────────────────────────

function buildWikilinkMap(vault: Vault): Map<string, string> {
	const map = new Map<string, string>();
	for (const file of vault.getMarkdownFiles()) {
		map.set(
			file.basename.toLowerCase(),
			"/" + sanitizeRoutePath(file.path),
		);
	}
	return map;
}

function resolveWikilink(
	target: string,
	map: Map<string, string>,
): { route: string; fragment: string } | null {
	const hashIdx = target.indexOf("#");
	const notePart = (
		hashIdx === -1 ? target : target.slice(0, hashIdx)
	).trim();
	const fragment = hashIdx === -1 ? "" : target.slice(hashIdx + 1).trim();
	const route = map.get(notePart.toLowerCase());
	if (!route) return null;
	return { route, fragment };
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]/g, "");
}

// ── Front-matter parser ────────────────────────────────────────────────────

function parseFrontMatter(markdown: string): {
	meta: Record<string, string>;
	body: string;
} {
	const meta: Record<string, string> = {};
	const m = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (m) {
		m[1].split("\n").forEach((line) => {
			const idx = line.indexOf(":");
			if (idx !== -1)
				meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		});
		return { meta, body: m[2] };
	}
	return { meta, body: markdown };
}

// ── Wikilink pre-processor ─────────────────────────────────────────────────

/**
 * Replace Obsidian wikilinks with standard markdown / HTML before rendering.
 *
 * ![[image.jpg]]          → <img src="/image.jpg" alt="image.jpg" />
 * ![[Note]] / ![[Note#S]] → <div class="wiki-embed" data-route="..." data-fragment="..."></div>
 * [[Note]] / [[Note|alias]]→ [alias](/route)   (standard md link — safe for renderMarkdown)
 */
function processWikilinks(
	body: string,
	wikilinkMap: Map<string, string>,
	linkedRoutes: Set<string>,
): string {
	// Embeds first
	body = body.replace(
		/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
		(_, target: string, alias: string | undefined) => {
			const filename = target.split("#")[0].trim();
			const ext = filename.split(".").pop()?.toLowerCase() ?? "";

			if (IMAGE_EXTENSIONS.has(ext)) {
				const alt = (alias ?? filename).trim();
				return `<img src="/${encodeURIComponent(filename)}" alt="${alt}" class="wiki-image" />`;
			}

			const resolved = resolveWikilink(target, wikilinkMap);
			if (!resolved)
				return `<span class="wiki-unresolved">${filename}</span>`;
			linkedRoutes.add(resolved.route);
			const { route, fragment } = resolved;
			return `<div class="wiki-embed" data-route="${encodeURIComponent(route)}" data-fragment="${encodeURIComponent(fragment)}"></div>`;
		},
	);

	// Plain links — emit standard markdown links so renderMarkdown handles them
	body = body.replace(
		/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
		(_, target: string, alias: string | undefined) => {
			const resolved = resolveWikilink(target, wikilinkMap);
			const noteName = target.split("#")[0].trim();
			const label = (alias ?? noteName).trim();
			if (!resolved)
				return `<span class="wiki-unresolved">${label}</span>`;
			linkedRoutes.add(resolved.route);
			const { route, fragment } = resolved;
			const href = fragment ? `${route}#${slugify(fragment)}` : route;
			// Use HTML <a> directly so the link survives renderMarkdown unchanged
			return `<a href="${href}" class="wiki-link internal-link" data-wiki-href="${route}" data-wiki-fragment="${encodeURIComponent(fragment)}">${label}</a>`;
		},
	);

	return body;
}

// ── Section AST ────────────────────────────────────────────────────────────

interface Section {
	level: number; // 1–6; 0 = preamble (content before first heading)
	title: string; // raw heading text (used for display + TOC)
	id: string; // slugified id
	snippetName: string; // valid JS identifier for the Svelte snippet
	lines: string[]; // raw markdown lines of this section's body only
	children: Section[];
}

/**
 * Parse a markdown body into a tree of Sections.
 * Each heading opens a new section; content before the first heading
 * goes into a virtual preamble section (level 0).
 */
function parseIntoSections(body: string): Section[] {
	const lines = body.split("\n");
	const root: Section[] = [];
	const stack: Section[] = [];
	let preamble: Section | null = null;
	const seenNames = new Set<string>();

	function makeSnippetName(title: string): string {
		let name = slugify(title)
			.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
			.replace(/[^a-zA-Z0-9_]/g, "_")
			.replace(/^[^a-zA-Z_]/, "_");
		if (!name) name = "section";
		let candidate = name;
		let n = 2;
		while (seenNames.has(candidate)) candidate = `${name}_${n++}`;
		seenNames.add(candidate);
		return candidate;
	}

	for (const line of lines) {
		const hMatch = line.match(/^(#{1,6})\s+(.*)/);
		if (hMatch) {
			const level = hMatch[1].length;
			const titleRaw = hMatch[2].trim();
			const titleText = stripHtml(titleRaw); // strip wikilink HTML for id/snippetName
			const title = titleRaw; // keep HTML for display in <hN>
			const id = slugify(titleText);
			const snippetName = makeSnippetName(titleText);

			while (stack.length > 0 && stack[stack.length - 1].level >= level) {
				stack.pop();
			}

			const section: Section = {
				level,
				title,
				id,
				snippetName,
				lines: [],
				children: [],
			};
			const parent =
				stack.length > 0 ? stack[stack.length - 1].children : root;
			parent.push(section);
			stack.push(section);
		} else {
			if (stack.length > 0) {
				stack[stack.length - 1].lines.push(line);
			} else {
				if (!preamble) {
					preamble = {
						level: 0,
						title: "",
						id: "_preamble",
						snippetName: "preamble",
						lines: [],
						children: [],
					};
					seenNames.add("preamble");
					root.unshift(preamble);
				}
				preamble.lines.push(line);
			}
		}
	}

	return root;
}

// ── Snippet generator ──────────────────────────────────────────────────────

// Regex to find embed placeholders emitted by processWikilinks
const EMBED_RE =
	/<div class="wiki-embed" data-route="([^"]*)" data-fragment="([^"]*)"><\/div>/g;

/**
 * Split markdown on embed placeholders, returning alternating chunks of
 * [markdown, EmbedBlock jsx, markdown, EmbedBlock jsx, ...]
 */
function splitEmbeds(md: string): string[] {
	const parts: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	EMBED_RE.lastIndex = 0;
	while ((m = EMBED_RE.exec(md)) !== null) {
		parts.push(md.slice(last, m.index));
		const route = decodeURIComponent(m[1]);
		const fragment = decodeURIComponent(m[2]);
		parts.push(
			`<EmbedBlock route={${JSON.stringify(route)}} fragment={${JSON.stringify(fragment)}} />`,
		);
		last = m.index + m[0].length;
	}
	parts.push(md.slice(last));
	return parts;
}

/** Emit Svelte markup for markdown that may contain embed placeholders. */
function emitMarkdown(md: string): string {
	return splitEmbeds(md)
		.map((part, i) => {
			if (i % 2 === 1) return `\t${part}`; // EmbedBlock component
			if (!part.trim()) return "";
			return `\t{@html renderMarkdown(${JSON.stringify(part)})}`;
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Recursively emit Svelte snippets for a section tree.
 * Each snippet renders its own markdown body + calls child snippets.
 */
function emitSnippets(sections: Section[]): string[] {
	const out: string[] = [];

	for (const sec of sections) {
		const childCalls = sec.children
			.map((c) => `\t{@render ${c.snippetName}()}`)
			.join("\n");

		const mdBody = emitMarkdown(sec.lines.join("\n"));

		let body = "";
		if (sec.level === 0) {
			body = [mdBody, childCalls].filter(Boolean).join("\n");
		} else {
			const Tag = `h${sec.level}`;
			body = `\t<section>\n\t\t<${Tag} id="${sec.id}">${sec.title}</${Tag}>\n${mdBody}\n${childCalls}\n\t</section>`;
		}

		out.push(`{#snippet ${sec.snippetName}()}\n${body}\n{/snippet}`);
		out.push(...emitSnippets(sec.children));
	}

	return out;
}

// ── Text helpers ──────────────────────────────────────────────────────────

/** Strip all HTML tags from a string, leaving only the text content. */
function stripHtml(html: string): string {
	return html.replace(/<[^>]+>/g, "").trim();
}

// ── Main transformer ───────────────────────────────────────────────────────

function markdownToSvelte(
	markdown: string,
	title: string,
	wikilinkMap: Map<string, string>,
): { pageSvelte: string; pageTs: string; linkedRoutes: string[] } {
	const { meta, body: rawBody } = parseFrontMatter(markdown);
	const pageTitle = meta["title"] || title;
	const pageDescription = meta["description"] || "";
	const isFullWidth = meta["full-width"]?.trim().toLowerCase() === "true";

	// Pre-process wikilinks before splitting into sections
	const linkedRoutes = new Set<string>();
	const body = processWikilinks(rawBody, wikilinkMap, linkedRoutes);

	const sections = parseIntoSections(body);

	// Collect all headings for the TOC store (flat list)
	const allHeadings: { id: string; text: string; level: number }[] = [];
	function collectHeadings(secs: Section[]) {
		for (const s of secs) {
			if (s.level > 0)
				allHeadings.push({
					id: s.id,
					text: stripHtml(s.title),
					level: s.level,
				});
			collectHeadings(s.children);
		}
	}
	collectHeadings(sections);

	const snippets = emitSnippets(sections);

	const topLevelCalls = sections
		.map((s) => `\t\t{@render ${s.snippetName}()}`)
		.join("\n");

	const pageSvelte = `<script lang="ts">
  import { onDestroy } from "svelte";
  import { tocHeadings } from "$lib/stores";
  import { renderMarkdown } from "$lib/markdownRenderer";
  import LinkPreview from "$lib/LinkPreview.svelte";
  import EmbedBlock from "$lib/EmbedBlock.svelte";

  tocHeadings.set(${JSON.stringify(allHeadings, null, 4).replace(/\n/g, "\n  ")});

  onDestroy(() => tocHeadings.set([]));
</script>

<svelte:head>
  <title>${pageTitle}</title>${pageDescription ? `\n  <meta name="description" content="${pageDescription}" />` : ""}
</svelte:head>

<article class="md-page">
  <header class="md-header">
    <h1>${pageTitle}</h1>${pageDescription ? `\n    <p class="description">${pageDescription}</p>` : ""}
  </header>
  <div class="markdown-rendered">
${topLevelCalls}
  </div>
</article>

<LinkPreview />

${snippets.join("\n\n")}
`;

	const pageTs = `import type { PageLoad } from "./$types";

export const prerender = true;

export const load: PageLoad = () => ({
  pageTitle: ${JSON.stringify(pageTitle)},
  pageDescription: ${JSON.stringify(pageDescription)},
  fullBleed: ${isFullWidth},
});
`;

	return { pageSvelte, pageTs, linkedRoutes: [...linkedRoutes] };
}
