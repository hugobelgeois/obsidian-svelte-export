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
