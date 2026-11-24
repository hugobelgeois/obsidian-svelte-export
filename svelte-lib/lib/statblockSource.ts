/**
 * Statblock sources and the data the plugin ships for the live ones —
 * shared by the plugin (src/liveStatblocks.ts, which writes that data) and
 * the site (liveStatblocks.ts, which runs it). Like shared.ts: keep it free
 * of SvelteKit imports and of anything browser- or Node-specific.
 */

/** Attribute a live statblock's container carries its LiveStatblock in. */
export const LIVE_STATBLOCK_ATTR = "data-live-statblock";

/** A Fantasy Statblocks layout block, as stored in the plugin's data.json. */
export interface LayoutBlock {
	type: string;
	properties?: string[];
	nested?: LayoutBlock[];
	conditions?: { condition?: string; nested: LayoutBlock[] }[];
	code?: string;
	[key: string]: unknown;
}

export interface LiveFile {
	/** Base-less URL path of the note's page. */
	route: string;
	/** Sources of its statblocks — all the site gets of the note. */
	sources: string[];
}

export interface LiveStatblock {
	/** Vault path of the note it's in. */
	path: string;
	/** Its position among that note's statblocks. */
	index: number;
	layout: LayoutBlock[];
	/** That note, and the published ones its source links to, by path. */
	files: Record<string, LiveFile>;
	/** Link path → vault path, for the links leading to `files`. */
	links: Record<string, string>;
	/** yamlChunks() chunk → what Obsidian's YAML parser makes of it, so the
	 * site needs no YAML parser of its own. */
	yaml: Record<string, unknown>;
}

/** The sources of the statblock code blocks in `markdown`. */
export function statblockSources(markdown: string): string[] {
	const fence =
		/^(`{3,}|~{3,})[ \t]*statblock[ \t]*\n([\s\S]*?)^\1[`~]*[ \t]*$/gm;
	return Array.from(
		markdown.replace(/\r/g, "").matchAll(fence),
		(m) => m[2] ?? "",
	);
}

/** Splits YAML into its top-level entries ("key: …" and the lines that
 * belong to it), each of which parses to the same thing on its own. */
export function yamlChunks(source: string): string[] {
	const chunks: string[] = [];
	for (const line of source.replace(/\r/g, "").split("\n")) {
		if (!line.trim() && !chunks.length) continue;
		if (/^[^\s#-][^:]*:(\s|$)/.test(line) || !chunks.length) {
			chunks.push(line);
		} else {
			chunks[chunks.length - 1] += "\n" + line;
		}
	}
	return chunks.map((c) => c.trimEnd()).filter(Boolean);
}

/** What Fantasy Statblocks does to a source before parsing it: links are
 * turned into markers, "[[…]]" being a nested list in YAML. */
export function markLinks(source: string): string {
	return source
		.replace(
			/\[\[([^\]]+?)\]\]/g,
			(_m, link: string) => `<STATBLOCK-WIKI-LINK>${link}<STATBLOCK-WIKI-LINK>`,
		)
		.replace(
			/\[([^\]]*?)\]\(([^)]+?)\)/g,
			(_m, label: string, url: string) =>
				`<STATBLOCK-MARKDOWN-LINK>${url}${label ? "|" + label : ""}<STATBLOCK-MARKDOWN-LINK>`,
		);
}

/** The reverse of markLinks(). */
export function unmarkLinks(text: string): string {
	return text
		.replace(
			/<STATBLOCK-WIKI-LINK>([\s\S]+?)<STATBLOCK-WIKI-LINK>/g,
			(_m, link: string) => `[[${link}]]`,
		)
		.replace(
			/<STATBLOCK-MARKDOWN-LINK>([\s\S]+?)(?:\|([\s\S]+?))?<STATBLOCK-MARKDOWN-LINK>/g,
			(_m, url: string, label?: string) => `[${label ?? ""}](${url})`,
		);
}
