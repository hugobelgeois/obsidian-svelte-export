import * as fs from "fs";
import { TFile, Vault } from "obsidian";
import * as path from "path";
import {
	BASE_PATH_SENTINEL,
	IMAGE_EXTENSIONS,
	sanitizeRoutePath,
	slugify,
} from "./constants";
import { PLUGIN_INTEGRATIONS, PluginBlockRenderer } from "./pluginIntegrations";

// ── Public API ─────────────────────────────────────────────────────────────

export interface ExportResult {
	linkedRoutes: string[];
	/** Every integration (PLUGIN_INTEGRATIONS) with a code block in this
	 * note — active or not, so a later change to that integration knows
	 * which pages to re-export. */
	pluginIds: string[];
	/** Absolute paths of local files rendered plugin blocks reference. */
	pluginAssets: string[];
}

/** Vault-wide lookups shared by every exported page — built once per
 * export by buildLinkMaps() rather than once per file. */
export interface LinkMaps {
	wikilinkMap: Map<string, string>;
	imageBasenameMap: Map<string, string>;
}

export function buildLinkMaps(vault: Vault): LinkMaps {
	return {
		wikilinkMap: buildWikilinkMap(vault),
		imageBasenameMap: buildImageBasenameMap(vault),
	};
}

export async function exportFile(
	file: TFile,
	destRoot: string,
	vault: Vault,
	pluginRenderer: PluginBlockRenderer,
	{ wikilinkMap, imageBasenameMap }: LinkMaps,
): Promise<ExportResult> {
	const markdown = await vault.read(file);
	const { meta, body } = parseFrontMatter(markdown);
	const plugins = await renderPluginBlocks(
		body,
		file.path,
		pluginRenderer,
		wikilinkMap,
	);
	const { pageSvelte, pageTs, linkedRoutes } = markdownToSvelte(
		meta,
		plugins.body,
		file.basename,
		wikilinkMap,
		imageBasenameMap,
		plugins,
	);

	// Sanitize path segments — apostrophes and other special chars break
	// Node ESM module resolution when SvelteKit imports the compiled route.
	const sanitizedPath = sanitizeRoutePath(file.path);

	const outputDir = path.join(destRoot, "src", "routes", sanitizedPath);
	fs.mkdirSync(outputDir, { recursive: true });

	fs.writeFileSync(path.join(outputDir, "+page.svelte"), pageSvelte, "utf-8");
	fs.writeFileSync(path.join(outputDir, "+page.ts"), pageTs, "utf-8");

	return {
		linkedRoutes,
		pluginIds: [...plugins.seenPluginIds],
		pluginAssets: [...plugins.assets],
	};
}

// ── Plugin code blocks ─────────────────────────────────────────────────────

interface PluginBlocks {
	/** Markdown with each rendered block swapped for a placeholder line. */
	body: string;
	/** Rendered HTML, indexed by the placeholder's data-index. */
	html: string[];
	/** Integrations actually rendered — their CSS gets imported. */
	renderedPluginIds: Set<string>;
	seenPluginIds: Set<string>;
	assets: Set<string>;
}

const KNOWN_PLUGIN_LANGUAGES = new Map(
	PLUGIN_INTEGRATIONS.flatMap((i) =>
		i.codeBlockLanguages.map((lang) => [lang, i.pluginId] as const),
	),
);

/**
 * Renders every fenced code block belonging to an active plugin
 * integration through the plugin itself (see PluginBlockRenderer), before
 * wikilinks are processed — the block's source (YAML for a statblock) has
 * to reach the plugin untouched.
 */
async function renderPluginBlocks(
	body: string,
	sourcePath: string,
	renderer: PluginBlockRenderer,
	wikilinkMap: Map<string, string>,
): Promise<PluginBlocks> {
	const result: PluginBlocks = {
		body,
		html: [],
		renderedPluginIds: new Set(),
		seenPluginIds: new Set(),
		assets: new Set(),
	};
	const resolveLink = (target: string) => {
		const resolved = resolveWikilink(target, wikilinkMap);
		return resolved ? BASE_PATH_SENTINEL + wikilinkHref(resolved) : null;
	};

	const lines = body.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const open = (lines[i] ?? "").match(/^\s*(`{3,}|~{3,})\s*([\w-]+)?/);
		if (!open) {
			out.push(lines[i] ?? "");
			i++;
			continue;
		}
		const fence = open[1] ?? "```";
		const lang = open[2] ?? "";
		const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
		let end = i + 1;
		while (end < lines.length && !closeRe.test(lines[end] ?? "")) end++;

		const knownId = KNOWN_PLUGIN_LANGUAGES.get(lang);
		if (knownId) result.seenPluginIds.add(knownId);
		const integration = renderer.integrationFor(lang);
		if (integration) {
			try {
				const rendered = await renderer.render(
					integration,
					lang,
					lines.slice(i + 1, end).join("\n"),
					sourcePath,
					resolveLink,
				);
				out.push(
					"",
					`<div class="plugin-block-placeholder" data-index="${result.html.length}"></div>`,
					"",
				);
				result.html.push(rendered.html);
				result.renderedPluginIds.add(integration.pluginId);
				rendered.assets.forEach((a) => result.assets.add(a));
				i = end + 1;
				continue;
			} catch (e) {
				console.error(
					`[SvelteExporter] ${integration.pluginId} failed to render a block in ${sourcePath}:`,
					e,
				);
			}
		}
		// Not a plugin block (or rendering failed): keep it verbatim, and
		// skip past its body so nothing inside is mistaken for a fence.
		out.push(...lines.slice(i, end + 1));
		i = end + 1;
	}
	result.body = out.join("\n");
	return result;
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

/**
 * Maps an image's filename (with extension), lowercased, to its real
 * on-disk casing — Obsidian resolves `![[...]]` embeds case-insensitively,
 * so a note can reference "hazdaim.png" while the actual file is
 * "Hazdaim.png". The image is always copied to static/ under its true
 * name (see main.ts), so the <img src> must use that same real casing, not
 * whatever case happens to be typed in the wikilink.
 */
function buildImageBasenameMap(vault: Vault): Map<string, string> {
	const map = new Map<string, string>();
	for (const file of vault.getFiles()) {
		if (!IMAGE_EXTENSIONS.has(file.extension)) continue;
		map.set(file.name.toLowerCase(), file.name);
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

/** Base-less href for a resolved wikilink, fragment slugified like heading ids. */
function wikilinkHref({ route, fragment }: { route: string; fragment: string }) {
	return fragment ? `${route}#${slugify(fragment)}` : route;
}

// ── Front-matter parser ────────────────────────────────────────────────────

function parseFrontMatter(markdown: string): {
	meta: Record<string, string>;
	body: string;
} {
	const meta: Record<string, string> = {};
	const m = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (m) {
		(m[1] ?? "").split("\n").forEach((line) => {
			const idx = line.indexOf(":");
			if (idx !== -1)
				meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		});
		return { meta, body: m[2] ?? "" };
	}
	return { meta, body: markdown };
}

// ── Wikilink pre-processor ─────────────────────────────────────────────────

/**
 * Replace Obsidian wikilinks with standard markdown / HTML before rendering.
 *
 * ![[image.jpg]]          → <img src="%%BASE%%/image.jpg" alt="image.jpg" />
 * ![[Note]] / ![[Note#S]] → <div class="wiki-embed" data-route="..." data-fragment="..."></div>
 * [[Note]] / [[Note|alias]]→ <a href="%%BASE%%/route" data-wiki-href="/route" …>alias</a>
 *
 * href/src carry the %%BASE%% sentinel (BASE_PATH_SENTINEL) since the
 * site's real base path isn't known yet at export time — see its doc
 * comment in constants.ts. data-route/data-wiki-href stay base-less on
 * purpose: they're only ever read by our own JS (wikiFetch.ts), which adds
 * the real base itself.
 */
function processWikilinks(
	body: string,
	wikilinkMap: Map<string, string>,
	imageBasenameMap: Map<string, string>,
	linkedRoutes: Set<string>,
): string {
	// Embeds first
	body = body.replace(
		/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
		(_, target: string, alias: string | undefined) => {
			const filename = (target.split("#")[0] ?? "").trim();
			const ext = filename.split(".").pop()?.toLowerCase() ?? "";

			if (IMAGE_EXTENSIONS.has(ext)) {
				// Images are always copied flat into static/ by their real
				// basename (see main.ts) regardless of which vault folder
				// they actually live in — so a wikilink target that
				// includes a folder prefix (e.g. "Images/Arek.png", which
				// Obsidian inserts whenever the bare filename alone isn't
				// unique) must be reduced to just the basename here too, or
				// the <img> src won't match where the file was copied.
				const typedBasename = filename.split("/").pop() ?? filename;
				// Obsidian resolves embeds case-insensitively, so the case
				// actually typed in the note (e.g. "hazdaim.png") may not
				// match the real file on disk (e.g. "Hazdaim.png") — since
				// the file was copied under its true name, the <img> src
				// must use that same real casing or it 404s.
				const basename =
					imageBasenameMap.get(typedBasename.toLowerCase()) ??
					typedBasename;
				// Obsidian's embed syntax uses the alias slot for a size
				// hint on images, not a caption — `![[img.png|300]]` means
				// "300px wide", `![[img.png|300x200]]` means "300x200" —
				// never real alt text, so that case falls back to the
				// filename for alt and becomes a width attribute instead.
				const sizeMatch = alias?.trim().match(/^(\d+)(?:x\d+)?$/);
				const widthAttr = sizeMatch ? ` width="${sizeMatch[1]}"` : "";
				const alt = (sizeMatch || !alias ? basename : alias).trim();
				// The sentinel is swapped for the site's real base path at
				// runtime (see BASE_PATH_SENTINEL's doc comment) — this
				// string is baked in long before that base path is known.
				return `<img src="${BASE_PATH_SENTINEL}/${encodeURIComponent(basename)}" alt="${alt}"${widthAttr} class="wiki-image" />`;
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
			const noteName = (target.split("#")[0] ?? "").trim();
			const label = (alias ?? noteName).trim();
			if (!resolved)
				return `<span class="wiki-unresolved">${label}</span>`;
			linkedRoutes.add(resolved.route);
			const { route, fragment } = resolved;
			const href = wikilinkHref(resolved);
			// Use HTML <a> directly so the link survives renderMarkdown unchanged.
			// data-wiki-href stays sentinel-free — LinkPreview.svelte/wikiFetch.ts
			// add the real base themselves when they fetch it.
			return `<a href="${BASE_PATH_SENTINEL}${href}" class="wiki-link internal-link" data-wiki-href="${route}" data-wiki-fragment="${encodeURIComponent(fragment)}">${label}</a>`;
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
			const level = (hMatch[1] ?? "").length;
			const titleRaw = (hMatch[2] ?? "").trim();
			const titleText = stripHtml(titleRaw); // strip wikilink HTML for id/snippetName
			const title = titleRaw; // keep HTML for display in <hN>
			const id = slugify(titleText);
			const snippetName = makeSnippetName(titleText);

			while (true) {
				const top = stack[stack.length - 1];
				if (!top || top.level < level) break;
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
			const parentTop = stack[stack.length - 1];
			const parent = parentTop ? parentTop.children : root;
			parent.push(section);
			stack.push(section);
		} else {
			const top = stack[stack.length - 1];
			if (top) {
				top.lines.push(line);
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

// Regex to find embed placeholders emitted by processWikilinks, and plugin
// block placeholders emitted by renderPluginBlocks
const EMBED_RE =
	/<div class="wiki-embed" data-route="([^"]*)" data-fragment="([^"]*)"><\/div>|<div class="plugin-block-placeholder" data-index="(\d+)"><\/div>/g;

/**
 * Split markdown on embed placeholders, returning alternating chunks of
 * [markdown, EmbedBlock jsx, markdown, EmbedBlock jsx, ...]
 */
function splitEmbeds(md: string, pluginHtml: string[]): string[] {
	const parts: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	EMBED_RE.lastIndex = 0;
	while ((m = EMBED_RE.exec(md)) !== null) {
		parts.push(md.slice(last, m.index));
		if (m[3] !== undefined) {
			const html = pluginHtml[Number(m[3])] ?? "";
			parts.push(
				`<div class="plugin-block">{@html applyBase(${JSON.stringify(html)})}</div>`,
			);
		} else {
			const route = decodeURIComponent(m[1] ?? "");
			const fragment = decodeURIComponent(m[2] ?? "");
			parts.push(
				`<EmbedBlock route={${JSON.stringify(route)}} fragment={${JSON.stringify(fragment)}} />`,
			);
		}
		last = m.index + m[0].length;
	}
	parts.push(md.slice(last));
	return parts;
}

/** Emit Svelte markup for markdown that may contain embed placeholders. */
function emitMarkdown(md: string, pluginHtml: string[]): string {
	return splitEmbeds(md, pluginHtml)
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
function emitSnippets(sections: Section[], pluginHtml: string[]): string[] {
	const out: string[] = [];

	for (const sec of sections) {
		const childCalls = sec.children
			.map((c) => `\t{@render ${c.snippetName}()}`)
			.join("\n");

		const mdBody = emitMarkdown(sec.lines.join("\n"), pluginHtml);

		let body = "";
		if (sec.level === 0) {
			body = [mdBody, childCalls].filter(Boolean).join("\n");
		} else {
			const Tag = `h${sec.level}`;
			// sec.title can itself contain wikilink-derived HTML (e.g. a
			// heading like "## See also [[Some Note]]") — that HTML still
			// carries the %%BASE%% sentinel (see BASE_PATH_SENTINEL), so it
			// must go through applyBase() at runtime via {@html} rather than
			// being spliced in as static template markup, which would leave
			// the literal sentinel in the compiled output forever.
			body = `\t<section>\n\t\t<${Tag} id="${sec.id}">{@html applyBase(${JSON.stringify(sec.title)})}</${Tag}>\n${mdBody}\n${childCalls}\n\t</section>`;
		}

		out.push(`{#snippet ${sec.snippetName}()}\n${body}\n{/snippet}`);
		out.push(...emitSnippets(sec.children, pluginHtml));
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
	meta: Record<string, string>,
	rawBody: string,
	title: string,
	wikilinkMap: Map<string, string>,
	imageBasenameMap: Map<string, string>,
	plugins: PluginBlocks,
): { pageSvelte: string; pageTs: string; linkedRoutes: string[] } {
	const pageTitle = meta["title"] || title;
	const pageDescription = meta["description"] || "";
	const isFullWidth = meta["full-width"]?.trim().toLowerCase() === "true";
	const isFullHeight = meta["full-height"]?.trim().toLowerCase() === "true";
	const isHideTitle = meta["hide-title"]?.trim().toLowerCase() === "true";

	// Pre-process wikilinks before splitting into sections
	const linkedRoutes = new Set<string>();
	const body = processWikilinks(
		rawBody,
		wikilinkMap,
		imageBasenameMap,
		linkedRoutes,
	);

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

	const snippets = emitSnippets(sections, plugins.html);

	// Written by writePluginCss() in main.ts — imported only by the pages
	// that need it, since a plugin's stylesheet can be large.
	const pluginCssImports = [...plugins.renderedPluginIds]
		.map((id) => `\n  import "$lib/pluginCss/${id}.css";`)
		.join("");

	const topLevelCalls = sections
		.map((s) => `\t\t{@render ${s.snippetName}()}`)
		.join("\n");

	// `title` still goes in <svelte:head> regardless — the browser tab and
	// SEO description shouldn't disappear just because the on-page heading
	// (the h1 a reader sees) is hidden via `hide-title`.
	const headerBlock = isHideTitle
		? ""
		: `  <header class="md-header">
    <h1>${pageTitle}</h1>${pageDescription ? `\n    <p class="description">${pageDescription}</p>` : ""}
  </header>
`;

	const pageSvelte = `<script lang="ts">
  import { onDestroy } from "svelte";
  import { tocHeadings } from "$lib/stores";
  import { applyBase, renderMarkdown } from "$lib/markdownRenderer";
  import LinkPreview from "$lib/LinkPreview.svelte";
  import EmbedBlock from "$lib/EmbedBlock.svelte";${pluginCssImports}

  tocHeadings.set(${JSON.stringify(allHeadings, null, 4).replace(/\n/g, "\n  ")});

  onDestroy(() => tocHeadings.set([]));
</script>

<svelte:head>
  <title>${pageTitle}</title>${pageDescription ? `\n  <meta name="description" content="${pageDescription}" />` : ""}
</svelte:head>

<article class="md-page">
${headerBlock}  <div class="markdown-rendered">
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
  fullHeight: ${isFullHeight},
});
`;

	return { pageSvelte, pageTs, linkedRoutes: [...linkedRoutes] };
}
