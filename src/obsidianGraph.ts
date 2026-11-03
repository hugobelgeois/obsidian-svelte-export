import * as fs from "fs";
import { App, TFile } from "obsidian";
import * as path from "path";
import { sanitizeRoutePath } from "./constants";
import { readJsonFile } from "./obsidianUtil";

// Reads the vault's core graph view settings (.obsidian/graph.json) so the
// exported graph matches it: color groups and force settings.

interface ColorGroup {
	query: string;
	color: { rgb: number; a?: number };
}

interface GraphJson {
	colorGroups?: ColorGroup[];
	centerStrength?: number;
	repelStrength?: number;
	linkStrength?: number;
	linkDistance?: number;
}

/** Forces as Obsidian's graph worker receives them — mirrored by the
 * GraphForces type in svelte-lib/lib/graphPhysics.ts. */
export interface GraphForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
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

/**
 * The graph view's "Forces" settings, converted the same way Obsidian
 * converts them before handing them to its simulation: center and link
 * force along a log scale, repel force cubed, link distance as-is.
 */
export function computeGraphForces(obsidianDir: string): GraphForces {
	const saved = readJsonFile<GraphJson>(path.join(obsidianDir, "graph.json"), {});
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

/**
 * A small subset of Obsidian's search syntax — just enough for typical
 * graph color group queries: `path:`/`file:`/`tag:` filters (plus a bare
 * term falling back to a path/filename match), space-separated terms ANDed
 * together. Does not support OR, NOT, regex, or full-text search —
 * Obsidian's real query language is much richer and not worth fully
 * reimplementing here for what's normally a handful of simple folder/tag
 * groupings.
 */
function matchesQuery(tokens: string[], file: TFile, app: App): boolean {
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
	// Parsed once up front, not once per file.
	const groups = colorGroups
		.filter((g) => g.query && typeof g.color?.rgb === "number")
		.map((g) => ({
			tokens: tokenizeQuery(g.query),
			color: rgbIntToHex(g.color.rgb),
		}));
	if (!groups.length) return {};

	const result: Record<string, string> = {};
	for (const file of files) {
		if (file.extension !== "md") continue;
		const group = groups.find((g) => matchesQuery(g.tokens, file, app));
		// Trailing slash to match Graph.svelte's node ids — leaf (file)
		// nodes in siteTree.ts always carry one, unlike the route strings
		// used elsewhere (nameMap.json, hidden.json).
		if (group) result["/" + sanitizeRoutePath(file.path) + "/"] = group.color;
	}
	return result;
}
