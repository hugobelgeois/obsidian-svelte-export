import { LINKS } from "./exportData";
import { withSlash } from "./routePath";

export interface LinkEdge {
	source: string;
	target: string;
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
		const s = withSlash(source);
		for (const rawTarget of targets) {
			const t = withSlash(rawTarget);
			if (s === t) continue;
			const key = s < t ? `${s}|${t}` : `${t}|${s}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: s, target: t });
		}
	}

	return edges;
}
