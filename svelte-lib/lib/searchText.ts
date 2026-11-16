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
				: original[i]!
						.normalize("NFD")
						.replace(/[̀-ͯ]/g, "")
						.toLowerCase();
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
	const words = foldText(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	const matches: {
		entry: SearchEntry;
		score: number;
		/** Where the first word found in the text is (-1: none is). */
		at: number;
		length: number;
	}[] = [];
	for (const { entry, title, text } of notes) {
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
			entry,
			score: (inTitle ? 1_000_000 : 0) + occurrences,
			at,
			length,
		});
	}
	// Snippets only for the hits that are shown.
	return matches
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ entry, at, length }) => ({
			route: entry.route,
			title: entry.title,
			snippet:
				at === -1
					? [excerptStart(entry.text, context * 2), "", ""]
					: around(fold(entry.text), at, length, context),
		}));
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
