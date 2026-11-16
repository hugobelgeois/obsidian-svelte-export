import { App, TFile } from "obsidian";
import * as path from "path";
import type { GraphForces } from "../svelte-lib/lib/shared";
import { isNote, pageRouteOf } from "./constants";
import { readJsonFile } from "./obsidianUtil";

// Reads the vault's core graph view settings (.obsidian/graph.json) so the
// exported graph matches it: color groups and force settings.

interface ColorGroup {
	query: string;
	color: { rgb: number; a?: number };
}

export interface GraphJson {
	colorGroups?: ColorGroup[];
	centerStrength?: number;
	repelStrength?: number;
	linkStrength?: number;
	linkDistance?: number;
}


/** Obsidian's own conversion from a "center/link force" slider position
 * (0–1, what graph.json stores) to the force actually applied. */
function sliderToForce(value: number): number {
	const min = 0.01;
	return (Math.pow(min, 1 - value) - min) / (1 - min);
}

/** Default slider positions of Obsidian's graph view "Forces" section. */
const DEFAULT_FORCE_SLIDERS = {
	centerStrength: 1 - Math.log(0.1 * (1 - 0.01) + 0.01) / Math.log(0.01),
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 250,
};

/** The vault's graph view settings — {} if it never saved any. Read once,
 * for both computeGraphForces() and computeNodeColors(). */
export function readGraphJson(obsidianDir: string): GraphJson {
	return readJsonFile<GraphJson>(
		path.join(obsidianDir, "graph.json"),
		{},
		"the vault's graph.json",
	);
}

/**
 * The graph view's "Forces" settings, converted the same way Obsidian
 * converts them before handing them to its simulation: center and link
 * force along a log scale, repel force cubed, link distance as-is.
 */
export function computeGraphForces(saved: GraphJson): GraphForces {
	const slider = (key: keyof typeof DEFAULT_FORCE_SLIDERS) => {
		const v = saved[key];
		return typeof v === "number" ? v : DEFAULT_FORCE_SLIDERS[key];
	};
	return {
		centerStrength: sliderToForce(slider("centerStrength")),
		repelStrength: slider("repelStrength") ** 3,
		linkStrength: sliderToForce(slider("linkStrength")),
		linkDistance: slider("linkDistance"),
	};
}

/**
 * Splits a graph color group query into terms, treating a `"quoted phrase"`
 * — with or without an immediately preceding `key:` and no space before the
 * quote — as one term (Obsidian's own queries do the same — see e.g.
 * `path:"Jeu/Sessions du Masque"`).
 */
function tokenizeQuery(query: string): string[] {
	const tokens: string[] = [];
	const re = /([a-zA-Z]+:)?"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(query)) !== null) {
		const token = m[2] !== undefined ? `${m[1] ?? ""}${m[2]}` : m[3];
		if (token) tokens.push(token);
	}
	return tokens;
}

/** One term of a color group query, parsed: its filter ("" for a bare
 * term) and lowercased value — "#tag" for a `tag:` term. */
interface QueryTerm {
	op: string;
	value: string;
}

/** A query's terms, parsed once — not again for every file. Null for a
 * query without any term, which matches nothing. (One whose terms are
 * all empty, like `path:""`, matches everything.) */
function parseQuery(query: string): QueryTerm[] | null {
	const tokens = tokenizeQuery(query);
	if (!tokens.length) return null;
	const terms: QueryTerm[] = [];
	for (const token of tokens) {
		const colonIdx = token.indexOf(":");
		const op = colonIdx > 0 ? token.slice(0, colonIdx).toLowerCase() : "";
		let value = (colonIdx > 0 ? token.slice(colonIdx + 1) : token)
			.replace(/^"|"$/g, "")
			.toLowerCase();
		if (!value) continue;
		if (op === "tag") value = `#${value.replace(/^#/, "")}`;
		terms.push({ op, value });
	}
	return terms;
}

/** What queries match a file on, lowercased — its tags only read (from
 * the metadata cache) if some `tag:` term asks. */
class FileFacts {
	readonly path: string;
	readonly name: string;
	private tagSet: Set<string> | null = null;

	constructor(
		private readonly file: TFile,
		private readonly app: App,
	) {
		this.path = file.path.toLowerCase();
		this.name = file.basename.toLowerCase();
	}

	/** Inline and front matter tags, as "#tag". */
	get tags(): Set<string> {
		if (!this.tagSet) {
			const cache = this.app.metadataCache.getFileCache(this.file);
			this.tagSet = new Set((cache?.tags ?? []).map((t) => t.tag.toLowerCase()));
			const fmTags: unknown = cache?.frontmatter?.tags;
			for (const t of Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []) {
				this.tagSet.add(`#${String(t).toLowerCase().replace(/^#/, "")}`);
			}
		}
		return this.tagSet;
	}
}

/**
 * A small subset of Obsidian's search syntax — just enough for typical
 * graph color group queries: `path:`/`file:`/`tag:` filters (plus a bare
 * term falling back to a path/filename match), space-separated terms ANDed
 * together. Does not support OR, NOT, regex, or full-text search —
 * Obsidian's real query language is much richer and not worth fully
 * reimplementing here for what's normally a handful of simple folder/tag
 * groupings.
 */
function matchesQuery(terms: QueryTerm[], file: FileFacts): boolean {
	// Every term must match (AND).
	return terms.every(({ op, value }) => {
		switch (op) {
			case "path":
				return file.path.includes(value);
			case "file":
				return file.name.includes(value);
			case "tag":
				return file.tags.has(value);
			default:
				return file.path.includes(value) || file.name.includes(value);
		}
	});
}

function rgbIntToHex(rgb: number): string {
	return "#" + (rgb >>> 0).toString(16).padStart(6, "0");
}

/**
 * Takes Obsidian's own graph color groups (.obsidian/graph.json — the same
 * ones configured in the core Graph view's "Groups" tab) and resolves,
 * for each given file, which group's color applies — the first matching
 * group in the list wins, same priority as the group order in Obsidian's
 * own graph view. Returns a map of sanitized route → hex color, for
 * whichever files matched at least one group (files matching none are
 * omitted, so the graph view falls back to its default color for them).
 */
export function computeNodeColors(
	app: App,
	graph: GraphJson,
	files: TFile[],
): Record<string, string> {
	const colorGroups = Array.isArray(graph.colorGroups) ? graph.colorGroups : [];
	// Parsed once up front, not once per file.
	const groups = colorGroups.flatMap((g) => {
		if (!g.query || typeof g.color?.rgb !== "number") return [];
		const terms = parseQuery(g.query);
		return terms ? [{ terms, color: rgbIntToHex(g.color.rgb) }] : [];
	});
	if (!groups.length) return {};

	const result: Record<string, string> = {};
	for (const file of files) {
		if (!isNote(file)) continue;
		const facts = new FileFacts(file, app);
		const group = groups.find((g) => matchesQuery(g.terms, facts));
		// Page routes (trailing slash) to match Graph.svelte's node ids,
		// unlike the route strings used elsewhere (nameMap.json, hidden.json).
		if (group) result[pageRouteOf(file.path)] = group.color;
	}
	return result;
}
