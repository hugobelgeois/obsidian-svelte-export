import { excerpt, stripDiacritics } from "./shared";

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
		const c = original.charCodeAt(i);
		// ASCII (most of any text): lowercasing is all there is to do, one
		// character for one — no need for normalize() and a regex.
		const f =
			c < 128
				? c >= 65 && c <= 90
					? String.fromCharCode(c + 32)
					: original[i]!
				: stripDiacritics(original[i]!).toLowerCase();
		folded += f;
		for (let k = 0; k < f.length; k++) sourceIndex.push(i);
	}
	return { original, folded, sourceIndex };
}

/** fold(text).folded, without building its sourceIndex. */
function foldText(text: string): string {
	return /^[\x00-\x7f]*$/.test(text) ? text.toLowerCase() : fold(text).folded;
}

export interface SearchHit {
	route: string;
	title: string;
	/** Excerpt around the first match: [before, match, after]. */
	snippet: [string, string, string];
}

/** An entry with its title and text already folded — the original's
 * sourceIndex is only worked out for the few hits actually shown. */
export interface PreparedEntry {
	entry: SearchEntry;
	title: string;
	text: string;
}

export function prepare(entries: SearchEntry[]): PreparedEntry[] {
	return entries.map((entry) => ({
		entry,
		title: foldText(entry.title),
		text: foldText(entry.text),
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
	return rank(findMatches(notes, foldText(query)), limit, context);
}

/**
 * search() for a search box: while the query only grows ("dra" → "drag"),
 * just the notes the previous query matched are searched again — every
 * word of the new query contains its counterpart in the old one, so no
 * other note can match it.
 */
export class Searcher {
	private lastQuery = "";
	private lastMatches: PreparedEntry[];

	constructor(private readonly notes: PreparedEntry[]) {
		this.lastMatches = notes;
	}

	search(query: string, limit = 30, context = 40): SearchHit[] {
		const folded = foldText(query);
		const pool =
			this.lastQuery && folded.startsWith(this.lastQuery)
				? this.lastMatches
				: this.notes;
		const matches = findMatches(pool, folded);
		this.lastQuery = folded.trim() ? folded : "";
		this.lastMatches = this.lastQuery
			? matches.map((m) => m.prepared)
			: this.notes;
		return rank(matches, limit, context);
	}
}

interface Match {
	prepared: PreparedEntry;
	score: number;
	/** Where the first word found in the text is (-1: none is). */
	at: number;
	length: number;
}

/** Every note in `notes` matching each word of the (folded) query. */
function findMatches(notes: PreparedEntry[], folded: string): Match[] {
	const words = folded.split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	const matches: Match[] = [];
	for (const prepared of notes) {
		const { title, text } = prepared;
		let found = true;
		let inTitle = true;
		let occurrences = 0;
		let at = -1;
		let length = 0;
		// One indexOf scan per word gives whether it's there, where it
		// first is, and how often it occurs.
		for (const w of words) {
			const inThisTitle = title.includes(w);
			if (!inThisTitle) inTitle = false;
			const first = text.indexOf(w);
			if (first === -1) {
				if (inThisTitle) continue;
				found = false;
				break;
			}
			if (at === -1) {
				at = first;
				length = w.length;
			}
			for (let i = first; i !== -1; i = text.indexOf(w, i + w.length)) {
				occurrences++;
			}
		}
		if (!found) continue;
		matches.push({
			prepared,
			score: (inTitle ? 1_000_000 : 0) + occurrences,
			at,
			length,
		});
	}
	return matches;
}

/** The best `limit` matches, name matches first, then by how often the
 * words occur — with snippets, worked out only for those. */
function rank(matches: Match[], limit: number, context: number): SearchHit[] {
	return topMatches(matches, limit).map(({ prepared: { entry }, at, length }) => ({
			route: entry.route,
			title: entry.title,
			snippet:
				at === -1
					? [excerpt(entry.text, context * 2), "", ""]
					: around(fold(entry.text), at, length, context),
		}));
}

/**
 * The `limit` highest-scoring matches, best first, ties in their original
 * order — what a (stable) sort then slice gives, without sorting every
 * match for a short list: once the list is full, a match only gets in by
 * beating its last one, which most don't.
 */
function topMatches(matches: Match[], limit: number): Match[] {
	const top: Match[] = [];
	if (limit <= 0) return top;
	for (const m of matches) {
		if (top.length === limit && m.score <= top[limit - 1]!.score) continue;
		let i = top.length;
		while (i > 0 && top[i - 1]!.score < m.score) i--;
		top.splice(i, 0, m);
		if (top.length > limit) top.pop();
	}
	return top;
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
