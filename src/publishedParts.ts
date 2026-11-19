import { App, type CachedMetadata, resolveSubpath, TFile } from "obsidian";
import { isNote, isWithinAny } from "./constants";
import { splitLinktext } from "./noteRenderer";

/**
 * What of each exported note the site publishes. A visible note (not
 * hidden from the file tree) is published whole. A hidden one only as far
 * as published content links to it: a link to the note itself publishes
 * all of it, a link to one of its headings ("[[B#Title]]") only that
 * heading's section, to a block ("[[B#^id]]") only that block — and a
 * hidden note nothing links to gets no page at all, so knowing its URL
 * leads nowhere. Embeds count as links (their content is on the
 * embedding page anyway), and so do the links in a hidden note's published
 * parts: what they lead to is published in turn.
 */

/** [start, end) character offsets in a note's file content. */
export type Range = [number, number];

/** All of a note, or only these parts of it (sorted, disjoint). */
export type PublishedPart = "all" | Range[];

/** End offset of a section running to the end of its note. */
const END_OF_NOTE = Number.MAX_SAFE_INTEGER;

/** Vault path → published part, for every exported note that has one. */
export function publishedParts(
	app: App,
	files: TFile[],
	hiddenPaths: string[],
): Map<string, PublishedPart> {
	const hidden = new Set(hiddenPaths);
	const exported = new Map(
		files.filter(isNote).map((f) => [f.path, f] as const),
	);
	const parts = new Map<string, PublishedPart>();
	// Newly published parts whose links haven't been followed yet.
	const pending: [TFile, PublishedPart][] = [];

	const publish = (file: TFile, part: PublishedPart) => {
		const current = parts.get(file.path);
		if (current === "all") return;
		if (part !== "all") {
			const merged = mergeRanges([...(current ?? []), ...part]);
			if (current && sameRanges(merged, current)) return;
			parts.set(file.path, merged);
		} else {
			parts.set(file.path, "all");
		}
		pending.push([file, part]);
	};

	for (const file of exported.values()) {
		if (!isWithinAny(file.path, hidden)) publish(file, "all");
	}

	for (let next; (next = pending.pop()); ) {
		const [file, part] = next;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
			if (part !== "all" && !inRanges(ref.position.start.offset, part)) {
				continue;
			}
			// Resolved as NoteRenderer resolves them: "#Heading" alone
			// is a link within the note itself.
			const { linkpath, fragment } = splitLinktext(ref.link);
			const dest = linkpath
				? app.metadataCache.getFirstLinkpathDest(linkpath, file.path)
				: file;
			if (!dest || !exported.has(dest.path)) continue;
			if (parts.get(dest.path) === "all") continue;
			if (!fragment) {
				publish(dest, "all");
				continue;
			}
			// A fragment matching nothing publishes nothing — the whole
			// note would be more than the link asked for.
			const section = sectionRange(app.metadataCache.getFileCache(dest), fragment);
			if (section) publish(dest, [section]);
		}
	}
	return parts;
}

/**
 * The range a link's fragment points to: a heading's section (the heading
 * down to the next one of the same or a higher level — what Obsidian
 * embeds for "![[B#Title]]"), or a block — from the start of its first
 * line, so partMarkdown() can remove its indentation evenly. Null for a
 * footnote or nothing found.
 */
function sectionRange(
	cache: CachedMetadata | null,
	fragment: string,
): Range | null {
	const target = cache && resolveSubpath(cache, `#${fragment}`);
	if (!target || target.type === "footnote") return null;
	const start =
		target.type === "block"
			? target.start.offset - target.start.col
			: target.start.offset;
	return [start, target.end?.offset ?? END_OF_NOTE];
}

/**
 * The Markdown of a note's published `ranges` (offsets in its whole file
 * content, `markdown`), one after the other — plus the definitions of the
 * footnotes they reference, which usually sit at the end of the note.
 */
export function partMarkdown(
	markdown: string,
	ranges: Range[],
	cache: CachedMetadata | null,
): string {
	const pieces = ranges.map(([s, e]) => dedent(markdown.slice(s, e)).trimEnd());
	const referenced = new Set(
		Array.from(pieces.join("\n").matchAll(/\[\^([^\]\s]+)\]/g), (m) => m[1]),
	);
	const footnotes = (cache?.footnotes ?? [])
		.filter(
			(f) =>
				referenced.has(f.id.replace(/^\^/, "")) &&
				!inRanges(f.position.start.offset, ranges),
		)
		.map((f) => markdown.slice(f.position.start.offset, f.position.end.offset));
	return [...pieces, ...footnotes].join("\n\n");
}

/** The offsets of the note's headings within `ranges` — the headings a
 * partial page shows, in order. */
export function headingOffsetsIn(
	cache: CachedMetadata | null,
	ranges: Range[],
): number[] {
	return (cache?.headings ?? [])
		.map((h) => h.position.start.offset)
		.filter((offset) => inRanges(offset, ranges));
}

/** What PageState records of a page's part: nothing for a whole note (as
 * before parts existed), its ranges otherwise. A change re-renders it. */
export function partKey(part: PublishedPart | undefined): string | undefined {
	return part === undefined || part === "all" ? undefined : JSON.stringify(part);
}

// ── Range helpers ──────────────────────────────────────────────────────────

export function mergeRanges(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: Range[] = [];
	for (const [s, e] of sorted) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else merged.push([s, e]);
	}
	return merged;
}

function sameRanges(a: Range[], b: Range[]): boolean {
	return (
		a.length === b.length &&
		a.every(([s, e], i) => s === b[i]?.[0] && e === b[i]?.[1])
	);
}

function inRanges(offset: number, ranges: Range[]): boolean {
	return ranges.some(([s, e]) => offset >= s && offset < e);
}

/** Removes the first line's indentation from every line — a nested list
 * item or indented block published alone would otherwise render as a
 * code block. */
export function dedent(text: string): string {
	const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
	if (!indent) return text;
	return text
		.split("\n")
		.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()))
		.join("\n");
}
