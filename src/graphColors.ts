import * as fs from "fs";
import { App, TFile } from "obsidian";
import * as path from "path";
import { sanitizeRoutePath } from "./constants";

interface ColorGroup {
	query: string;
	color: { rgb: number; a?: number };
}

interface GraphJson {
	colorGroups?: ColorGroup[];
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

/**
 * A small subset of Obsidian's search syntax — just enough for typical
 * graph color group queries: `path:`/`file:`/`tag:` filters (plus a bare
 * term falling back to a path/filename match), space-separated terms ANDed
 * together. Does not support OR, NOT, regex, or full-text search —
 * Obsidian's real query language is much richer and not worth fully
 * reimplementing here for what's normally a handful of simple folder/tag
 * groupings.
 */
function matchesQuery(query: string, file: TFile, app: App): boolean {
	const tokens = tokenizeQuery(query);
	if (!tokens.length) return false;

	for (const token of tokens) {
		const colonIdx = token.indexOf(":");
		const op = colonIdx > 0 ? token.slice(0, colonIdx).toLowerCase() : "";
		const value = (colonIdx > 0 ? token.slice(colonIdx + 1) : token)
			.replace(/^"|"$/g, "")
			.toLowerCase();
		if (!value) continue;

		let matched: boolean;
		switch (op) {
			case "path":
				matched = file.path.toLowerCase().includes(value);
				break;
			case "file":
				matched = file.basename.toLowerCase().includes(value);
				break;
			case "tag": {
				const cache = app.metadataCache.getFileCache(file);
				const inlineTags = (cache?.tags ?? []).map((t) =>
					t.tag.toLowerCase(),
				);
				const fmTags: unknown = cache?.frontmatter?.tags;
				const frontmatterTags: string[] = (
					Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []
				).map(
					(t: unknown) => `#${String(t).toLowerCase().replace(/^#/, "")}`,
				);
				const wanted = `#${value.replace(/^#/, "")}`;
				matched =
					inlineTags.includes(wanted) || frontmatterTags.includes(wanted);
				break;
			}
			default:
				matched =
					file.path.toLowerCase().includes(value) ||
					file.basename.toLowerCase().includes(value);
		}
		if (!matched) return false; // every term must match (AND)
	}
	return true;
}

function rgbIntToHex(rgb: number): string {
	return "#" + (rgb >>> 0).toString(16).padStart(6, "0");
}

/**
 * Reads Obsidian's own graph color groups (.obsidian/graph.json — the same
 * ones configured in the core Graph view's "Groups" tab) and resolves,
 * for each given file, which group's color applies — the first matching
 * group in the list wins, same priority as the group order in Obsidian's
 * own graph view. Returns a map of sanitized route → hex color, for
 * whichever files matched at least one group (files matching none are
 * omitted, so the graph view falls back to its default color for them).
 */
export function computeNodeColors(
	app: App,
	obsidianDir: string,
	files: TFile[],
): Record<string, string> {
	const graphJsonPath = path.join(obsidianDir, "graph.json");
	if (!fs.existsSync(graphJsonPath)) return {};

	let colorGroups: ColorGroup[];
	try {
		const parsed = JSON.parse(
			fs.readFileSync(graphJsonPath, "utf-8"),
		) as GraphJson;
		colorGroups = Array.isArray(parsed.colorGroups) ? parsed.colorGroups : [];
	} catch {
		console.warn("[SvelteExporter] Could not parse the vault's graph.json");
		return {};
	}
	if (!colorGroups.length) return {};

	const result: Record<string, string> = {};
	for (const file of files) {
		if (file.extension !== "md") continue;
		for (const group of colorGroups) {
			if (!group.query || typeof group.color?.rgb !== "number") continue;
			if (matchesQuery(group.query, file, app)) {
				// Trailing slash to match Graph.svelte's node ids — leaf
				// (file) nodes in siteTree.ts always carry one, unlike the
				// route strings used elsewhere (nameMap.json, hidden.json).
				result["/" + sanitizeRoutePath(file.path) + "/"] = rgbIntToHex(
					group.color.rgb,
				);
				break;
			}
		}
	}
	return result;
}
