/**
 * Draws one frame of the graph view (Graph.svelte) onto a View's canvas:
 * edges, nodes, labels, the current note's halo, hover dimming, the
 * progressive reveal and the active animation's visual effects.
 */
import type { GraphAnimation } from "$lib/animations/types";
import type { GNode } from "$lib/graphTypes";
import type { View } from "$lib/graphView";

/** Theme colors the graph is drawn with — see Graph.svelte's getColors(). */
export interface GraphColors {
	colorEdge: string;
	colorNode: string;
	colorActive: string;
	colorLabel: string;
	colorBg: string;
}

/** Everything a frame shows, besides the view itself. */
export interface GraphScene {
	nodes: GNode[];
	edges: { source: GNode; target: GNode }[];
	nodeIndex: Map<string, GNode>;
	/** Node id → ids of every node it's directly linked to. */
	adjacency: Map<string, string[]>;
	/** Route of the note being viewed — "" if none. */
	currentPath: string;
	/** Current note + its direct links. */
	currentNeighbors: Set<string>;
	showOnlyLinked: boolean;
	animation: GraphAnimation | undefined;
	/** Obsidian's own graph "Groups" colors, by node id. */
	nodeColors: Record<string, string>;
	colors: GraphColors;
}

/** `id` itself plus every note directly linked to it (empty for null). */
export function withNeighbors(
	adjacency: Map<string, string[]>,
	id: string | null,
): Set<string> {
	return id ? new Set([id, ...(adjacency.get(id) ?? [])]) : new Set();
}

/** Same size formula for every node — only depends on its link count. */
function baseRadius(n: GNode, scale: number): number {
	return (3.5 + Math.min(n.degree, 6) * 0.55) / scale;
}

// ── Progressive reveal (standalone page only) ───────────────────────────────

/** How long a revealed node takes to pop in. */
export const REVEAL_FADE_MS = 320;

function revealEase(n: GNode, now: number): number {
	if (!n.revealed) return 0;
	if (n.revealedAt === null) return 1;
	const t = Math.min(1, (now - n.revealedAt) / REVEAL_FADE_MS);
	if (t >= 1) return 1;
	return 1 - Math.pow(1 - t, 3); // ease-out cubic "pop"
}

// ── Periodic animation (standalone page + popup modal) ──────────────────────
// The actual effect lives in lib/animations/ — Graph.svelte triggers it,
// and it's drawn here (radius, glow, offset). Purely visual: it never
// touches n.x/n.y, so there's no risk of the layout itself drifting.

/** Generic radius multiplier from the active animation's intensity —
 * shared by every intensity-based animation so individual animation
 * files don't each need their own "how big does a highlighted node get"
 * constant. Animations that need to shrink a node (not just grow it)
 * provide getSizeScale instead, which takes priority here. */
const INTENSITY_MAX_SCALE = 1.7;

function animationScale(
	animation: GraphAnimation | undefined,
	n: GNode,
	now: number,
): number {
	if (animation?.getSizeScale) {
		return Math.max(0.05, animation.getSizeScale(n, now));
	}
	const t = animation?.getIntensity?.(n, now) ?? 0;
	return 1 + (INTENSITY_MAX_SCALE - 1) * t;
}

// ── Hover dimming (eased, not instant) ──────────────────────────────────────
// Frame-rate-independent exponential smoothing: after DIM_TAU_MS
// milliseconds, dimAlpha has closed ~63% of the gap to its target; after
// 3× that (~0.5–1s total, per DIM_TAU_MS below) it's visually settled.

export const DIM_TAU_MS = 250;

function updateDimAlpha(n: GNode, target: number, dt: number) {
	const k = 1 - Math.exp(-dt / DIM_TAU_MS);
	n.dimAlpha += (target - n.dimAlpha) * k;
}

// ── Frame ────────────────────────────────────────────────────────────────────

/** Scratch positions, reused every frame rather than allocated per node. */
const p = { x: 0, y: 0 };
const sp = { x: 0, y: 0 };
const tp = { x: 0, y: 0 };

/**
 * Draws `scene` onto `view`'s canvas. `isModal` is the big view (popup or
 * standalone page) — the only one with the animation's offsets, group
 * colors and degree-based labels. `dimDt` is the time since the previous
 * frame, for the hover dimming's easing.
 */
export function drawGraph(
	view: View,
	scene: GraphScene,
	isModal: boolean,
	now: number,
	dimDt: number,
) {
	if (!view.canvas || view.width <= 0 || view.height <= 0) return;
	const ctx = view.canvas.getContext("2d");
	if (!ctx) return;
	const { nodes, edges, animation, currentPath, showOnlyLinked } = scene;

	// The animation's positional offset is a big-view-only effect
	// (standalone page + popup modal, never the small sidebar preview)
	// and purely visual — it never touches n.x/n.y, so this is the only
	// place it exists.
	function place(n: GNode, out: { x: number; y: number }) {
		out.x = n.x;
		out.y = n.y;
		if (!isModal) return;
		const off = animation?.getOffset?.(n, now);
		if (!off) return;
		out.x += off.dx;
		out.y += off.dy;
	}

	const dpr = window.devicePixelRatio || 1;
	const targetW = Math.round(view.width * dpr);
	const targetH = Math.round(view.height * dpr);
	if (view.canvas.width !== targetW || view.canvas.height !== targetH) {
		view.canvas.width = targetW;
		view.canvas.height = targetH;
	}

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, view.width, view.height);
	ctx.save();
	ctx.translate(view.panX, view.panY);
	ctx.scale(view.scale, view.scale);

	const { colorEdge, colorNode, colorActive, colorLabel, colorBg } =
		scene.colors;

	const neighborIds = scene.currentNeighbors;
	// Filter (2): restrict to current note + its direct neighbors.
	const visibleIds = showOnlyLinked ? neighborIds : null;

	const hovered = view.hoveredId ? scene.nodeIndex.get(view.hoveredId) : null;
	const linkedToHovered = withNeighbors(scene.adjacency, hovered?.id ?? null);

	// Label mode: in the big view with "all notes" shown, every note's
	// name visibility depends on how many links it has (more links =
	// more visible at the default zoom, zero links = invisible), and
	// zooming in gradually reveals everyone regardless of link count.
	// Otherwise: just current + hovered, plus direct neighbors too when
	// the big view is filtered down to them.
	const degreeFade = isModal && !showOnlyLinked;
	const zoomRatio = view.fitScale > 0 ? view.scale / view.fitScale : 1;
	// 0 once at (or below) the default fit scale, growing as you zoom in.
	const zoomBoost = Math.max(0, zoomRatio - 1) * 0.5;

	const labelIds = new Set<string>();
	if (!degreeFade) {
		for (const n of nodes) {
			if (visibleIds && !visibleIds.has(n.id)) continue;
			const isCurrent = n.id === currentPath;
			const isHovered = n.id === view.hoveredId;
			const isNearCurrent = isModal && neighborIds.has(n.id);
			if (isCurrent || isHovered || isNearCurrent) labelIds.add(n.id);
		}
	}
	// The more names would be drawn at once, the more transparent each
	// one is, so a heavily-connected note's neighbor labels don't turn
	// into an unreadable block of overlapping text — but never so
	// transparent they stop being "permanently visible".
	const labelAlpha = Math.max(
		0.55,
		Math.min(1, 10 / Math.max(labelIds.size, 1)),
	);

	/** Returns null when this node shouldn't get a label at all. */
	function getLabelAlpha(n: GNode): number | null {
		// The node under the cursor always gets its full name at full
		// opacity — degree-based fade and the "many labels at once"
		// dimming are both about decluttering everything else, not this.
		if (n.id === view.hoveredId) return 1;
		if (degreeFade) {
			const degreeComponent = Math.min(n.degree, 8) / 8; // 0..1
			const a = Math.min(1, degreeComponent * 0.85 + zoomBoost);
			return a <= 0.03 ? null : a;
		}
		return labelIds.has(n.id) ? labelAlpha : null;
	}

	// Edges — (1) always visible: a solid base opacity that never fades
	// toward nothing, only brightened further when connected to the
	// hovered note. Every edge of one style goes into a single path,
	// stroked once — one stroke() per edge was most of a frame's cost.
	const plainEdges = new Path2D();
	const hoveredEdges = new Path2D();
	for (const { source: s, target: t } of edges) {
		if (!s.revealed || !t.revealed) continue;
		if (visibleIds && !(visibleIds.has(s.id) && visibleIds.has(t.id)))
			continue;
		const isHighlighted =
			!!hovered && (s.id === hovered.id || t.id === hovered.id);
		const path = isHighlighted ? hoveredEdges : plainEdges;
		place(s, sp);
		place(t, tp);
		path.moveTo(sp.x, sp.y);
		path.lineTo(tp.x, tp.y);
	}
	ctx.strokeStyle = colorEdge;
	ctx.globalAlpha = 0.65;
	ctx.lineWidth = 1.1 / view.scale;
	ctx.stroke(plainEdges);
	// Drawn after the others, so they sit on top of them.
	ctx.strokeStyle = colorActive;
	ctx.globalAlpha = 1;
	ctx.lineWidth = 1.8 / view.scale;
	ctx.stroke(hoveredEdges);

	// Nodes — draw the current note LAST (in its own pass) so it always
	// sits on top of everything else, with a halo — but sized the same
	// as everyone else, purely by degree (not because it's "the" note).
	ctx.font = `${11 / view.scale}px system-ui, sans-serif`;
	let currentNode: GNode | null = null;
	for (const n of nodes) {
		if (!n.revealed) continue;
		if (visibleIds && !visibleIds.has(n.id)) continue;
		const isCurrent = n.id === currentPath;
		if (isCurrent) {
			currentNode = n;
			continue;
		}
		const isHovered = n.id === view.hoveredId;
		const dimmed = !!hovered && !linkedToHovered.has(n.id);
		updateDimAlpha(n, dimmed ? 0.35 : 1, dimDt);
		const ease = revealEase(n, now);
		const baseR = baseRadius(n, view.scale);
		const intensity = animation?.getIntensity?.(n, now) ?? 0;
		const r = baseR * ease * animationScale(animation, n, now);
		place(n, p);

		if (intensity > 0.01) {
			// Soft glow behind the node, same treatment as the "current
			// note" halo below — this is what an intensity-based
			// animation (e.g. flicker) reads as a "twinkle".
			ctx.globalAlpha = intensity * 0.5 * ease;
			ctx.beginPath();
			ctx.arc(p.x, p.y, baseR * 2.2, 0, Math.PI * 2);
			ctx.fillStyle = colorActive;
			ctx.fill();
		}

		// Obsidian's own graph "Groups" color — big-view-only (matches
		// how the graph's own periodic animations are scoped), never
		// applied to the small sidebar preview.
		const groupColor = isModal ? scene.nodeColors[n.id] : undefined;

		ctx.globalAlpha = n.dimAlpha * ease;
		ctx.beginPath();
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
		ctx.fillStyle = isHovered ? colorLabel : (groupColor ?? colorNode);
		ctx.fill();

		if (isHovered) {
			ctx.lineWidth = 2 / view.scale;
			ctx.strokeStyle = colorBg;
			ctx.stroke();
		}

		const labelA = getLabelAlpha(n);
		if (labelA !== null) {
			ctx.globalAlpha = Math.min(labelA, n.dimAlpha) * ease;
			ctx.fillStyle = colorLabel;
			ctx.fillText(n.label, p.x + r + 4 / view.scale, p.y + 4 / view.scale);
		}
	}

	if (
		currentNode?.revealed &&
		(!visibleIds || visibleIds.has(currentNode.id))
	) {
		const ease = revealEase(currentNode, now);
		// Same size formula as every other node — only the color and
		// halo mark it as "you are here", not an oversized radius.
		const r =
			baseRadius(currentNode, view.scale) *
			ease *
			animationScale(animation, currentNode, now);
		place(currentNode, p);
		// Halo: soft glow behind the node so it reads as "the" focal point.
		ctx.globalAlpha = 0.28 * ease;
		ctx.beginPath();
		ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
		ctx.fillStyle = colorActive;
		ctx.fill();

		ctx.globalAlpha = ease;
		ctx.beginPath();
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
		ctx.fillStyle = colorActive;
		ctx.fill();
		ctx.lineWidth = 2.5 / view.scale;
		ctx.strokeStyle = colorBg;
		ctx.stroke();

		ctx.font = `bold ${12 / view.scale}px system-ui, sans-serif`;
		ctx.fillStyle = colorLabel;
		ctx.fillText(
			currentNode.label,
			p.x + r + 5 / view.scale,
			p.y + 4.5 / view.scale,
		);
	}

	ctx.globalAlpha = 1;
	ctx.restore();
}
