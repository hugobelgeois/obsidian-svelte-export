/** One node in the graph-view simulation. Shared between Graph.svelte (which
 * owns the physics/rendering) and every animation module under
 * lib/animations/ (which only read positions/state to compute a purely
 * visual effect — see lib/animations/types.ts). */
export interface GNode {
	id: string;
	label: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Set while the node is being dragged; null = free to move. */
	fx: number | null;
	fy: number | null;
	degree: number;
	/** Every node it's directly linked to — the nodes themselves, so
	 * walking the graph needs no id lookups. */
	neighbors: GNode[];
	/** Progressive reveal (standalone page only). Always true outside
	 * standalone mode. */
	revealed: boolean;
	/** Timestamp (performance.now()) revealed became true; drives the
	 * pop-in fade/scale. Null once the fade has fully finished. */
	revealedAt: number | null;
	/** Animated toward 1 (normal) or 0.35 (dimmed, hovering elsewhere) —
	 * eased over time instead of snapping. */
	dimAlpha: number;
}

/**
 * A random revealed node (each equally likely), or null if none is. A few
 * random picks first — outside the standalone page's progressive reveal,
 * every node is revealed — and only if they all miss, a pick among the
 * revealed ones, rather than listing them on every animation tick.
 */
export function randomRevealedNode(nodes: GNode[]): GNode | null {
	if (!nodes.length) return null;
	for (let attempt = 0; attempt < 8; attempt++) {
		const n = nodes[Math.floor(Math.random() * nodes.length)]!;
		if (n.revealed) return n;
	}
	const pool = nodes.filter((n) => n.revealed);
	return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/** Bounding box of the current position of every node (`include`d, if
 * given) — infinite (min > max) when there are none. */
export function nodeBounds(nodes: GNode[], include?: (n: GNode) => boolean) {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const n of nodes) {
		if (include && !include(n)) continue;
		if (n.x < minX) minX = n.x;
		if (n.x > maxX) maxX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.y > maxY) maxY = n.y;
	}
	return { minX, minY, maxX, maxY };
}
