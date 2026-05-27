import { writable } from "svelte/store";

export interface TocHeading {
	id: string;
	text: string;
	level: number;
}

/** Headings of the currently displayed page, used by the ToC sidebar. */
export const tocHeadings = writable<TocHeading[]>([]);

// Paths hidden from the file tree (populated by +layout.ts)
export const hiddenPaths = writable<string[]>([]);
