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

/** The ids of `node` itself plus every note directly linked to it (empty
 * for none). */
export function withNeighbors(node: GNode | null | undefined): Set<string> {
	const ids = new Set<string>();
	if (!node) return ids;
	ids.add(node.id);
	for (const n of node.neighbors) ids.add(n.id);
	return ids;
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

/** `intensity`: the animation's getIntensity() for this node and frame. */
function animationScale(
	animation: GraphAnimation | undefined,
	n: GNode,
	now: number,
	intensity: number,
): number {
	if (animation?.getSizeScale) {
		return Math.max(0.05, animation.getSizeScale(n, now));
	}
	return 1 + (INTENSITY_MAX_SCALE - 1) * intensity;
}

// ── Hover dimming (eased, not instant) ──────────────────────────────────────
// Frame-rate-independent exponential smoothing: after DIM_TAU_MS
// milliseconds, dimAlpha has closed ~63% of the gap to its target; after
// 3× that (~0.5–1s total, per DIM_TAU_MS below) it's visually settled.

export const DIM_TAU_MS = 250;

function updateDimAlpha(n: GNode, target: number, dt: number) {
	const k = 1 - Math.exp(-dt / DIM_TAU_MS);
	n.dimAlpha += (target - n.dimAlpha) * k;
	// Snapped once indistinguishable, so settled nodes share one opacity
	// (and one batched fill — see drawGraph).
	if (Math.abs(target - n.dimAlpha) < 0.002) n.dimAlpha = target;
}

// ── Frame ────────────────────────────────────────────────────────────────────

/** Per node (by index in scene.nodes), reused every frame: whether it's
 * drawn, and where — worked out once per node, not again for each of its
 * edges (an animation's getOffset() can be costly, e.g. raindrop's loops
 * over every drop). */
let shown = new Uint8Array(0);
let drawX = new Float64Array(0);
let drawY = new Float64Array(0);
/** Labels queued while drawing the nodes, drawn after all of them —
 * reused every frame (only the first `labelCount` entries are current). */
const labelTexts: string[] = [];
const labelXs: number[] = [];
const labelYs: number[] = [];
const labelAlphas: number[] = [];

/** Memoizes `compute` on its last arguments (compared with ===) — for
 * what a frame derives from state that only changes on hover or
 * navigation, rather than recomputing it every frame. */
function memoizeLast<A extends unknown[], R>(
	compute: (...args: A) => R,
): (...args: A) => R {
	let lastArgs: A | null = null;
	let last: R | undefined;
	return (...args: A): R => {
		const prev = lastArgs;
		if (!prev || args.some((a, i) => a !== prev[i])) {
			last = compute(...args);
			lastArgs = args;
		}
		return last as R;
	};
}

/** withNeighbors() of the hovered node. */
const neighborsOf = memoizeLast(withNeighbors);

/** Each node's index in `nodes`, and each edge's two ends as such indices
 * (source at 2k, target at 2k + 1) — worked out once: the component
 * keeps the same arrays for its whole lifetime. */
const graphIndices = memoizeLast(
	(nodes: GNode[], edges: { source: GNode; target: GNode }[]) => {
		const index = new Map(nodes.map((n, i) => [n, i]));
		const ends = new Int32Array(edges.length * 2);
		edges.forEach(({ source, target }, k) => {
			ends[2 * k] = index.get(source) ?? -1;
			ends[2 * k + 1] = index.get(target) ?? -1;
		});
		return ends;
	},
);

/**
 * Which nodes get a name when labels don't depend on degree (sidebar
 * preview, or the big view filtered to linked notes): the current and
 * hovered notes, plus — in the big view — the current note's direct links.
 * The more names would be drawn at once, the more transparent each one is,
 * so a heavily-connected note's neighbor labels don't turn into an
 * unreadable block of overlapping text — but never so transparent they
 * stop being "permanently visible". Only those candidates are looked at,
 * not every node.
 */
const labelledNodes = memoizeLast(
	(
		nodeIndex: Map<string, GNode>,
		neighborIds: Set<string>,
		showOnlyLinked: boolean,
		currentPath: string,
		hoveredId: string | null,
		isModal: boolean,
	) => {
		const ids = new Set<string>();
		const add = (id: string) => {
			if (!nodeIndex.has(id)) return;
			if (showOnlyLinked && !neighborIds.has(id)) return; // filtered out
			ids.add(id);
		};
		add(currentPath);
		if (hoveredId) add(hoveredId);
		if (isModal) neighborIds.forEach(add);
		const alpha = Math.max(0.55, Math.min(1, 10 / Math.max(ids.size, 1)));
		return { ids, alpha };
	},
);

/**
 * The opacity of `n`'s label, or null when it gets none: by degree (and
 * zoom, `zoomBoost`) when `labelled` is null, else only for the nodes in
 * it (see labelledNodes).
 */
function labelAlpha(
	n: GNode,
	hoveredId: string | null,
	labelled: { ids: Set<string>; alpha: number } | null,
	zoomBoost: number,
): number | null {
	// The node under the cursor always gets its full name at full
	// opacity — degree-based fade and the "many labels at once"
	// dimming are both about decluttering everything else, not this.
	if (n.id === hoveredId) return 1;
	if (!labelled) {
		const degreeComponent = Math.min(n.degree, 8) / 8; // 0..1
		const a = Math.min(1, degreeComponent * 0.85 + zoomBoost);
		return a <= 0.03 ? null : a;
	}
	return labelled.ids.has(n.id) ? labelled.alpha : null;
}

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
	// (standalone page + popup modal, never the small sidebar preview).
	const offsets = isModal ? animation : undefined;

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
	const linkedToHovered = neighborsOf(hovered);

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

	const labelled = degreeFade
		? null
		: labelledNodes(
				scene.nodeIndex,
				neighborIds,
				showOnlyLinked,
				currentPath,
				view.hoveredId,
				isModal,
			);

	// Edges — (1) always visible: a solid base opacity that never fades
	// toward nothing, only brightened further when connected to the
	// hovered note. Every edge of one style goes into a single path,
	// stroked once — one stroke() per edge was most of a frame's cost.
	// Where every drawn node is (see `shown`) — the animation's positional
	// offset included. Purely visual: n.x/n.y are never touched, so this is
	// the only place the offset exists.
	if (shown.length < nodes.length) {
		shown = new Uint8Array(nodes.length);
		drawX = new Float64Array(nodes.length);
		drawY = new Float64Array(nodes.length);
	}
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		const drawn = n.revealed && (!visibleIds || visibleIds.has(n.id));
		shown[i] = drawn ? 1 : 0;
		if (!drawn) continue;
		const off = offsets?.getOffset?.(n, now);
		drawX[i] = off ? n.x + off.dx : n.x;
		drawY[i] = off ? n.y + off.dy : n.y;
	}

	const ends = graphIndices(nodes, edges);
	const plainEdges = new Path2D();
	const hoveredEdges = new Path2D();
	for (let k = 0; k < edges.length; k++) {
		const s = ends[2 * k]!;
		const t = ends[2 * k + 1]!;
		if (s < 0 || t < 0 || !shown[s] || !shown[t]) continue;
		const isHighlighted =
			!!hovered && (nodes[s] === hovered || nodes[t] === hovered);
		const path = isHighlighted ? hoveredEdges : plainEdges;
		path.moveTo(drawX[s]!, drawY[s]!);
		path.lineTo(drawX[t]!, drawY[t]!);
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

	// Nodes — batched like the edges: every node of the same color and
	// opacity (rounded to 1%) goes into one path, filled once. The hovered
	// node (outlined) is drawn on its own, then every label, so no name
	// hides under a neighboring node. The current note is drawn LAST (in
	// its own pass) so it always sits on top of everything else, with a
	// halo — but sized the same as everyone else, purely by degree (not
	// because it's "the" note).
	/** Color → opacity level (0–100) → that batch's path. */
	const fills = new Map<string, (Path2D | undefined)[]>();
	let labelCount = 0;
	let hoveredR = -1;
	let hoveredX = 0;
	let hoveredY = 0;
	let hoveredAlpha = 0;
	let current = -1;
	for (let i = 0; i < nodes.length; i++) {
		if (!shown[i]) continue;
		const n = nodes[i]!;
		if (n.id === currentPath) {
			current = i;
			continue;
		}
		const x = drawX[i]!;
		const y = drawY[i]!;
		const isHovered = n.id === view.hoveredId;
		const dimmed = !!hovered && !linkedToHovered.has(n.id);
		updateDimAlpha(n, dimmed ? 0.35 : 1, dimDt);
		const ease = revealEase(n, now);
		const baseR = baseRadius(n, view.scale);
		const intensity = animation?.getIntensity?.(n, now) ?? 0;
		const r = baseR * ease * animationScale(animation, n, now, intensity);

		if (intensity > 0.01) {
			// Soft glow behind the node, same treatment as the "current
			// note" halo below — this is what an intensity-based
			// animation (e.g. flicker) reads as a "twinkle".
			ctx.globalAlpha = intensity * 0.5 * ease;
			ctx.beginPath();
			ctx.arc(x, y, baseR * 2.2, 0, Math.PI * 2);
			ctx.fillStyle = colorActive;
			ctx.fill();
		}

		const alpha = n.dimAlpha * ease;
		if (isHovered) {
			hoveredR = r;
			hoveredX = x;
			hoveredY = y;
			hoveredAlpha = alpha;
		} else {
			const level = Math.round(alpha * 100);
			if (level > 0) {
				// Obsidian's own graph "Groups" color — big-view-only
				// (matches how the graph's own periodic animations are
				// scoped), never applied to the small sidebar preview.
				const color =
					(isModal ? scene.nodeColors[n.id] : undefined) ?? colorNode;
				let byLevel = fills.get(color);
				if (!byLevel) fills.set(color, (byLevel = []));
				const path = (byLevel[level] ??= new Path2D());
				// Each circle its own subpath — no line joining it to the
				// previous one.
				path.moveTo(x + r, y);
				path.arc(x, y, r, 0, Math.PI * 2);
			}
		}

		const labelA = labelAlpha(n, view.hoveredId, labelled, zoomBoost);
		if (labelA !== null) {
			labelTexts[labelCount] = n.label;
			labelXs[labelCount] = x + r + 4 / view.scale;
			labelYs[labelCount] = y + 4 / view.scale;
			labelAlphas[labelCount] = Math.min(labelA, n.dimAlpha) * ease;
			labelCount++;
		}
	}

	for (const [color, byLevel] of fills) {
		ctx.fillStyle = color;
		byLevel.forEach((path, level) => {
			if (!path) return;
			ctx.globalAlpha = level / 100;
			ctx.fill(path);
		});
	}

	if (hoveredR >= 0) {
		ctx.globalAlpha = hoveredAlpha;
		ctx.beginPath();
		ctx.arc(hoveredX, hoveredY, hoveredR, 0, Math.PI * 2);
		ctx.fillStyle = colorLabel;
		ctx.fill();
		ctx.lineWidth = 2 / view.scale;
		ctx.strokeStyle = colorBg;
		ctx.stroke();
	}

	ctx.fillStyle = colorLabel;
	for (let i = 0; i < labelCount; i++) {
		ctx.globalAlpha = labelAlphas[i]!;
		ctx.fillText(labelTexts[i]!, labelXs[i]!, labelYs[i]!);
	}

	const currentNode = current >= 0 ? nodes[current]! : null;
	if (currentNode) {
		const x = drawX[current]!;
		const y = drawY[current]!;
		const ease = revealEase(currentNode, now);
		// Same size formula as every other node — only the color and
		// halo mark it as "you are here", not an oversized radius.
		const r =
			baseRadius(currentNode, view.scale) *
			ease *
			animationScale(
				animation,
				currentNode,
				now,
				animation?.getIntensity?.(currentNode, now) ?? 0,
			);
		// Halo: soft glow behind the node so it reads as "the" focal point.
		ctx.globalAlpha = 0.28 * ease;
		ctx.beginPath();
		ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
		ctx.fillStyle = colorActive;
		ctx.fill();

		ctx.globalAlpha = ease;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = colorActive;
		ctx.fill();
		ctx.lineWidth = 2.5 / view.scale;
		ctx.strokeStyle = colorBg;
		ctx.stroke();

		ctx.font = `bold ${12 / view.scale}px system-ui, sans-serif`;
		ctx.fillStyle = colorLabel;
		ctx.fillText(
			currentNode.label,
			x + r + 5 / view.scale,
			y + 4.5 / view.scale,
		);
	}

	ctx.globalAlpha = 1;
	ctx.restore();
}
