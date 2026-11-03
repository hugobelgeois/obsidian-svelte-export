import { LINKS } from "./exportData";

export interface LinkEdge {
	source: string;
	target: string;
}

/** Route format used elsewhere (siteTree/Graph node ids) always ends in "/". */
function normalize(route: string): string {
	return route.endsWith("/") ? route : route + "/";
}

/**
 * Real note-to-note wikilinks, deduplicated into a single undirected edge
 * per pair (A→B and B→A collapse to one line in the graph, matching how
 * Obsidian's own graph view displays links).
 */
export function getLinkEdges(): LinkEdge[] {
	const edges: LinkEdge[] = [];
	const seen = new Set<string>();

	for (const [source, targets] of Object.entries(LINKS)) {
		const s = normalize(source);
		for (const rawTarget of targets) {
			const t = normalize(rawTarget);
			if (s === t) continue;
			const key = [s, t].sort().join("|");
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: s, target: t });
		}
	}

	return edges;
}
