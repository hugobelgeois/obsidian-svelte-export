/**
 * Pan/zoom geometry of one graph canvas (Graph.svelte's sidebar preview or
 * big view): fitting every node in view, screen ↔ world coordinates,
 * hit-testing and zooming. Pure functions over a View — the component owns
 * the views and decides when to call these.
 */
import type { GNode } from "$lib/graphTypes";

/** Independent pan/zoom/hover state for one canvas (sidebar vs. modal). */
export interface View {
	canvas: HTMLCanvasElement | null;
	width: number;
	height: number;
	scale: number;
	/** The "fit all nodes" scale, tracked even after a manual zoom moves
	 * `scale` away from it — used as the zoom-in reference point for
	 * degree-based label transparency. */
	fitScale: number;
	panX: number;
	panY: number;
	hoveredId: string | null;
	dragNode: GNode | null;
	isPanning: boolean;
	userAdjusted: boolean;
	lastX: number;
	lastY: number;
	moved: boolean;
}

export function createView(): View {
	return {
		canvas: null,
		width: 0,
		height: 0,
		scale: 1,
		fitScale: 1,
		panX: 0,
		panY: 0,
		hoveredId: null,
		dragNode: null,
		isPanning: false,
		userAdjusted: false,
		lastX: 0,
		lastY: 0,
		moved: false,
	};
}

/** Actual bounding box of every node's current position. */
function computeBounds(nodes: GNode[]) {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const n of nodes) {
		if (n.x < minX) minX = n.x;
		if (n.x > maxX) maxX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.y > maxY) maxY = n.y;
	}
	if (!isFinite(minX)) {
		minX = minY = -50;
		maxX = maxY = 50;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Fit the view so every node is visible (3), based on their real
 * bounding box rather than an assumed fixed area. Only updates `fitScale`
 * once the user zoomed/panned by hand, unless `force`d.
 */
export function fitView(view: View, nodes: GNode[], force = false) {
	if (view.width <= 0 || view.height <= 0) return;
	const { minX, minY, maxX, maxY } = computeBounds(nodes);
	const w = Math.max(maxX - minX, 1);
	const h = Math.max(maxY - minY, 1);
	const margin = 28;
	const idealScale = Math.max(
		Math.min(
			Math.min(
				(view.width - margin * 2) / w,
				(view.height - margin * 2) / h,
			),
			3,
		),
		0.05,
	);
	view.fitScale = idealScale;

	if (view.userAdjusted && !force) return;
	view.scale = idealScale;
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	view.panX = view.width / 2 - cx * view.scale;
	view.panY = view.height / 2 - cy * view.scale;
}

/** Recenter (pan only, keep current zoom level) on `node`. */
export function centerOn(view: View, node: GNode | null | undefined) {
	if (!node || view.width <= 0 || view.height <= 0) return;
	view.panX = view.width / 2 - node.x * view.scale;
	view.panY = view.height / 2 - node.y * view.scale;
}

/** The world (simulation) position under a screen point. */
export function toWorld(view: View, clientX: number, clientY: number) {
	const rect = view.canvas!.getBoundingClientRect();
	const sx = clientX - rect.left;
	const sy = clientY - rect.top;
	return {
		x: (sx - view.panX) / view.scale,
		y: (sy - view.panY) / view.scale,
	};
}

/** The node closest to a world position, within a few screen pixels. */
export function nodeAt(
	view: View,
	nodes: GNode[],
	wx: number,
	wy: number,
): GNode | null {
	const hitR = 10 / view.scale;
	let best: GNode | null = null;
	let bestDist = hitR;
	for (const n of nodes) {
		const dx = n.x - wx;
		const dy = n.y - wy;
		const d = Math.sqrt(dx * dx + dy * dy);
		if (d < bestDist) {
			best = n;
			bestDist = d;
		}
	}
	return best;
}

/** Zoom `view` at a screen point, keeping that point fixed under the cursor. */
export function zoomAt(
	view: View,
	clientX: number,
	clientY: number,
	deltaY: number,
) {
	if (!view.canvas) return;
	const rect = view.canvas.getBoundingClientRect();
	const cx = clientX - rect.left;
	const cy = clientY - rect.top;
	const zoomFactor = Math.exp(-deltaY * 0.001);
	const newScale = Math.min(Math.max(view.scale * zoomFactor, 0.05), 5);
	const wx = (cx - view.panX) / view.scale;
	const wy = (cy - view.panY) / view.scale;
	view.scale = newScale;
	view.panX = cx - wx * newScale;
	view.panY = cy - wy * newScale;
	view.userAdjusted = true;
}
