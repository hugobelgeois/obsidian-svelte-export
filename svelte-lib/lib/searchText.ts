/** One note in static/search.json — written by writeSearchIndex() in the
 * plugin's src/siteFiles.ts. */
export interface SearchEntry {
	route: string;
	title: string;
	text: string;
}

/** Text folded for matching (lowercase, accents removed), plus where each
 * folded character came from in the original — so a match found in the
 * folded text can be shown in the original, accents and all. */
export interface FoldedText {
	original: string;
	folded: string;
	/** folded index → original index */
	sourceIndex: number[];
}

export function fold(original: string): FoldedText {
	let folded = "";
	const sourceIndex: number[] = [];
	for (let i = 0; i < original.length; i++) {
		const f = original[i]!
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase();
		folded += f;
		for (let k = 0; k < f.length; k++) sourceIndex.push(i);
	}
	return { original, folded, sourceIndex };
}

export interface SearchHit {
	route: string;
	title: string;
	/** Excerpt around the first match: [before, match, after]. */
	snippet: [string, string, string];
}

export interface PreparedEntry {
	entry: SearchEntry;
	title: FoldedText;
	text: FoldedText;
}

export function prepare(entries: SearchEntry[]): PreparedEntry[] {
	return entries.map((entry) => ({
		entry,
		title: fold(entry.title),
		text: fold(entry.text),
	}));
}

/**
 * Notes whose name or text contains every word of `query` (ignoring case
 * and accents) — name matches first, then by how often the words occur.
 */
export function search(
	notes: PreparedEntry[],
	query: string,
	limit = 30,
	context = 40,
): SearchHit[] {
	const words = fold(query).folded.split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	const hits: { hit: SearchHit; score: number }[] = [];
	for (const { entry, title, text } of notes) {
		const found = words.every(
			(w) => title.folded.includes(w) || text.folded.includes(w),
		);
		if (!found) continue;
		const inTitle = words.every((w) => title.folded.includes(w));
		// Excerpt around the first word found in the text, if any.
		const word = words.find((w) => text.folded.includes(w));
		const snippet: SearchHit["snippet"] = word
			? around(text, text.folded.indexOf(word), word.length, context)
			: [excerptStart(text.original, context * 2), "", ""];
		const occurrences = words.reduce(
			(n, w) => n + text.folded.split(w).length - 1,
			0,
		);
		hits.push({
			hit: { route: entry.route, title: entry.title, snippet },
			score: (inTitle ? 1_000_000 : 0) + occurrences,
		});
	}
	return hits
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((h) => h.hit);
}

function excerptStart(text: string, length: number): string {
	return text.length > length ? text.slice(0, length) + "…" : text;
}

/** [before, match, after] in the original text, for a match at folded
 * index `at` of folded length `length`. */
function around(
	text: FoldedText,
	at: number,
	length: number,
	context: number,
): [string, string, string] {
	const start = text.sourceIndex[at] ?? 0;
	const end = (text.sourceIndex[at + length - 1] ?? start) + 1;
	const from = Math.max(0, start - context);
	const to = Math.min(text.original.length, end + context);
	return [
		(from > 0 ? "…" : "") + text.original.slice(from, start),
		text.original.slice(start, end),
		text.original.slice(end, to) + (to < text.original.length ? "…" : ""),
	];
}
