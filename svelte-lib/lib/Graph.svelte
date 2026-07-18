<script lang="ts">
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/stores";
	import { animationRegistry, randomAnimationId } from "$lib/animationRegistry";
	import { ANIMATION_INTERVAL_SECONDS, ANIMATION_TYPE } from "$lib/graphConfig";
	import type { GNode } from "$lib/graphTypes";
	import { getLinkEdges } from "$lib/linkGraph";
	import { toRoutePath } from "$lib/routePath";
	import { flattenTree, siteTree } from "$lib/siteTree";
	import { onDestroy, onMount } from "svelte";

	// "random" picks one animation id here, once, when this component is
	// created (i.e. once per page load) — not re-rolled on every reactive
	// update, so it stays the same animation for the whole visit.
	const resolvedAnimationType =
		ANIMATION_TYPE === "random"
			? (randomAnimationId() ?? "none")
			: ANIMATION_TYPE;

	/** The selected animation module, if any (undefined for "none" or an id
	 * that no longer matches a file in lib/animations/). */
	const activeAnimation = animationRegistry.get(resolvedAnimationType);

	/** When true, render as a full in-page view (used as the site's default
	 * page) instead of the small sidebar preview + popup modal. Body.svelte
	 * fills the page for this mode via the route's `fullBleed` load data
	 * (see +page.ts next to the generated standalone route), not a prop
	 * here — that data is resolved before any component renders, avoiding
	 * the ordering issue of a child trying to signal an ancestor. */
	let { standalone = false }: { standalone?: boolean } = $props();

	// ── Types ────────────────────────────────────────────────────────────────

	interface GLink {
		source: string;
		target: string;
	}

	/** Independent pan/zoom/hover state for one canvas (sidebar vs. modal). */
	interface View {
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

	function createView(): View {
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

	// ── Graph data (structure is static — built once) ───────────────────────

	/** Logical simulation space; each view maps this to its own pixel size. */
	const SIM_SIZE = 320;

	const files = flattenTree(siteTree);

	const nodes: GNode[] = files.map((f) => ({
		id: f.path,
		label: f.name,
		x: Math.random() * SIM_SIZE,
		y: Math.random() * SIM_SIZE,
		vx: 0,
		vy: 0,
		fx: null,
		fy: null,
		degree: 0,
		// Standalone starts every node hidden and reveals them progressively
		// (see revealOrder below); every other mode shows everything at once.
		revealed: !standalone,
		revealedAt: null,
		dimAlpha: 1,
	}));

	const nodeIndex = new Map<string, GNode>(nodes.map((n) => [n.id, n]));

	// Real wikilinks resolved by the plugin (links.json), not folder
	// hierarchy — this is what makes the graph mirror actual note
	// relationships instead of a nearly-empty pseudo-graph.
	const links: GLink[] = getLinkEdges().filter(
		(l) => nodeIndex.has(l.source) && nodeIndex.has(l.target),
	);

	for (const l of links) {
		nodeIndex.get(l.source)!.degree++;
		nodeIndex.get(l.target)!.degree++;
	}

	// ── Progressive reveal (standalone page only) ───────────────────────────
	// Order: the most-connected node first, then its neighbors (breadth-
	// first, each frontier visited most-connected-first), so the reveal
	// grows outward from each "hub" the same way the eye would explore the
	// graph. Once a whole connected component is exhausted, jump to the
	// next most-connected node not yet reached (covers disconnected notes).
	function computeRevealOrder(): string[] {
		const adjacency = new Map<string, string[]>();
		for (const n of nodes) adjacency.set(n.id, []);
		for (const l of links) {
			adjacency.get(l.source)?.push(l.target);
			adjacency.get(l.target)?.push(l.source);
		}

		const byDegreeDesc = [...nodes].sort((a, b) => b.degree - a.degree);
		const visited = new Set<string>();
		const order: string[] = [];

		for (const start of byDegreeDesc) {
			if (visited.has(start.id)) continue;
			const queue: string[] = [start.id];
			visited.add(start.id);
			while (queue.length) {
				const id = queue.shift()!;
				order.push(id);
				const neighbors = (adjacency.get(id) ?? [])
					.filter((nid) => !visited.has(nid))
					.sort(
						(a, b) =>
							(nodeIndex.get(b)?.degree ?? 0) -
							(nodeIndex.get(a)?.degree ?? 0),
					);
				for (const nid of neighbors) {
					visited.add(nid);
					queue.push(nid);
				}
			}
		}
		return order;
	}

	const revealOrder: string[] = standalone ? computeRevealOrder() : [];
	// Stagger tuned so a small vault reveals briskly and a huge one doesn't
	// take forever — capped total runtime, floored per-node step.
	const REVEAL_STEP_MS = Math.max(
		25,
		Math.min(70, 4000 / Math.max(revealOrder.length, 1)),
	);
	const REVEAL_FADE_MS = 320;
	let revealCursor = 0;
	let nextRevealAt = 0;

	function revealEase(n: GNode, now: number): number {
		if (!n.revealed) return 0;
		if (n.revealedAt === null) return 1;
		const t = Math.min(1, (now - n.revealedAt) / REVEAL_FADE_MS);
		if (t >= 1) return 1;
		return 1 - Math.pow(1 - t, 3); // ease-out cubic "pop"
	}

	// ── Periodic animation (standalone page + popup modal) ──────────────────
	// The actual effect lives in lib/animations/ — see activeAnimation above
	// and advanceAnimation()/drawPos() below for how it's driven and drawn.
	// Both hooks are purely visual and never touch n.x/n.y, so there's no
	// risk of the layout itself drifting.

	/** Generic radius multiplier from the active animation's intensity —
	 * shared by every intensity-based animation so individual animation
	 * files don't each need their own "how big does a highlighted node get"
	 * constant. Animations that need to shrink a node (not just grow it)
	 * provide getSizeScale instead, which takes priority here. */
	const INTENSITY_MAX_SCALE = 1.7;

	function animationScale(n: GNode, now: number): number {
		if (activeAnimation?.getSizeScale) {
			return Math.max(0.05, activeAnimation.getSizeScale(n, now));
		}
		const t = activeAnimation?.getIntensity?.(n, now) ?? 0;
		return 1 + (INTENSITY_MAX_SCALE - 1) * t;
	}

	// ── Hover dimming (eased, not instant) ──────────────────────────────────
	// Frame-rate-independent exponential smoothing: after DIM_TAU_MS
	// milliseconds, dimAlpha has closed ~63% of the gap to its target; after
	// 3× that (~0.5–1s total, per DIM_TAU_MS below) it's visually settled.
	const DIM_TAU_MS = 250;
	let lastDimFrameTime = 0;

	function updateDimAlpha(n: GNode, target: number, dt: number) {
		const k = 1 - Math.exp(-dt / DIM_TAU_MS);
		n.dimAlpha += (target - n.dimAlpha) * k;
	}

	// ── Physics (continuous, animated — settles instead of blocking once) ──

	let alpha = 1;
	/** Multiplicative decay: settling slows down gradually instead of
	 * stopping abruptly after a fixed time — it keeps going for as long as
	 * there's meaningful motion left (3). */
	const ALPHA_DECAY_RATE = 0.985;
	const ALPHA_MIN = 0.005;
	const REPULSION = 2600;
	const REST_LENGTH = 46;
	const SPRING = 0.05;
	/** Never let two nodes get closer than this for repulsion-force purposes
	 * — without it, repulsion (∝ 1/dist²) blows up as dist→0 and a dragged
	 * node can fling its neighbors across the screen in a single frame. */
	const MIN_DIST = 12;
	/** Hard minimum on-screen separation between any two nodes (2) — unlike
	 * MIN_DIST above (which only softens the repulsion force), this is a
	 * real position constraint, enforced every frame regardless of alpha,
	 * so nodes never end up overlapping even once the layout has settled. */
	const MIN_SEPARATION = 18;
	/** Hard cap on how far a node can move in one frame, regardless of how
	 * large the accumulated force was. */
	const MAX_SPEED = 6;
	/** Nodes settle inside this radius (4); dragging one out is fine, but it
	 * springs back in once released. */
	const BOUNDARY_R = SIM_SIZE * 0.42;
	const BOUNDARY_PULL = 0.05;

	function reheat() {
		alpha = 1;
	}

	function step() {
		const cx = SIM_SIZE / 2;
		const cy = SIM_SIZE / 2;

		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DIST);
				const force = (REPULSION * alpha) / (dist * dist);
				const fx = (force * dx) / dist;
				const fy = (force * dy) / dist;
				if (a.fx === null) {
					a.vx -= fx;
					a.vy -= fy;
				}
				if (b.fx === null) {
					b.vx += fx;
					b.vy += fy;
				}
			}
		}

		for (const l of links) {
			const s = nodeIndex.get(l.source);
			const t = nodeIndex.get(l.target);
			if (!s || !t) continue;
			const dx = t.x - s.x;
			const dy = t.y - s.y;
			const dist = Math.sqrt(dx * dx + dy * dy) || 1;
			const force = (dist - REST_LENGTH) * SPRING * alpha;
			const fx = (force * dx) / dist;
			const fy = (force * dy) / dist;
			if (s.fx === null) {
				s.vx += fx;
				s.vy += fy;
			}
			if (t.fx === null) {
				t.vx -= fx;
				t.vy -= fy;
			}
		}

		// (1): the current note and its direct neighbors get an extra pull
		// toward the center, on top of the degree-based one below, so they
		// stay as close to the middle as possible regardless of how many
		// links they otherwise have.
		const focusIds = getCurrentNeighborIds();

		for (const n of nodes) {
			if (n.fx !== null && n.fy !== null) {
				n.x = n.fx;
				n.y = n.fy;
				n.vx = 0;
				n.vy = 0;
				continue;
			}

			// (4): the more a note is linked, the more strongly it's pulled
			// toward the center — so well-connected hubs keep the middle of
			// the graph filled instead of everything spreading into a
			// hollow ring around an empty center.
			const degreeFactor = 1 + Math.min(n.degree, 10) * 0.35;
			const focusFactor = focusIds.has(n.id) ? 2.2 : 1;
			n.vx += (cx - n.x) * 0.006 * alpha * degreeFactor * focusFactor;
			n.vy += (cy - n.y) * 0.006 * alpha * degreeFactor * focusFactor;

			// Elastic circular boundary (4): only pushes back once a node
			// drifts past BOUNDARY_R, gently, proportional to the overshoot.
			const ddx = n.x - cx;
			const ddy = n.y - cy;
			const distFromCenter = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
			if (distFromCenter > BOUNDARY_R) {
				const excess = distFromCenter - BOUNDARY_R;
				const pull = excess * BOUNDARY_PULL;
				n.vx -= (ddx / distFromCenter) * pull;
				n.vy -= (ddy / distFromCenter) * pull;
			}

			// Cap speed so one big force spike can never fling a node across
			// the screen in a single frame (3).
			const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
			if (speed > MAX_SPEED) {
				n.vx = (n.vx / speed) * MAX_SPEED;
				n.vy = (n.vy / speed) * MAX_SPEED;
			}

			n.x += n.vx * 0.6;
			n.y += n.vy * 0.6;
			n.vx *= 0.82;
			n.vy *= 0.82;
		}

		// Settling slows down but never hard-stops — it keeps contributing
		// a small amount of motion for as long as nodes are still adjusting.
		alpha = Math.max(alpha * ALPHA_DECAY_RATE, ALPHA_MIN);
	}

	/**
	 * Hard minimum-separation constraint (2), enforced every frame
	 * regardless of alpha/settling state or dragging — directly nudges
	 * apart any two nodes closer than MIN_SEPARATION so they never
	 * overlap, even after the layout has fully settled.
	 */
	function enforceSeparation() {
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				let dist = Math.sqrt(dx * dx + dy * dy);
				if (dist >= MIN_SEPARATION) continue;
				if (dist < 0.001) dist = 0.001;
				const overlap = (MIN_SEPARATION - dist) / 2;
				const nx = dx / dist;
				const ny = dy / dist;
				const aFixed = a.fx !== null;
				const bFixed = b.fx !== null;
				if (!aFixed && !bFixed) {
					a.x -= nx * overlap;
					a.y -= ny * overlap;
					b.x += nx * overlap;
					b.y += ny * overlap;
				} else if (!aFixed) {
					a.x -= nx * overlap * 2;
					a.y -= ny * overlap * 2;
				} else if (!bFixed) {
					b.x += nx * overlap * 2;
					b.y += ny * overlap * 2;
				}
			}
		}
	}

	/**
	 * Smooth, local-only push away from an actively dragged node — this is
	 * what makes nearby nodes drift out of the way while dragging, without
	 * relying on reheat()'s global alpha (which would reactivate forces for
	 * every pair in the graph, not just around the drag). Unlike
	 * enforceSeparation()'s hard MIN_SEPARATION cutoff (nothing, then a
	 * sudden snap at an exact radius), this fades continuously to zero — no
	 * boundary to see. Added to velocity, not position, so the normal
	 * damping in step() carries it into an organic decelerate-and-settle
	 * instead of an instant nudge.
	 */
	const DRAG_PUSH_RADIUS = 27; // sim-units — well past this, effectively zero
	const DRAG_PUSH_STRENGTH = 3.5;

	function applyDragRepulsion(dragNode: GNode) {
		for (const n of nodes) {
			if (n === dragNode || n.fx !== null) continue;
			const dx = n.x - dragNode.x;
			const dy = n.y - dragNode.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist >= DRAG_PUSH_RADIUS || dist < 0.001) continue;
			const t = dist / DRAG_PUSH_RADIUS;
			const falloff = (1 - t) * (1 - t); // 0 at the radius edge, and flat there (no snap)
			const force = DRAG_PUSH_STRENGTH * falloff;
			n.vx += (dx / dist) * force;
			n.vy += (dy / dist) * force;
		}
	}

	// ── Views & shared display state ─────────────────────────────────────────

	const sidebarView = createView();
	const modalView = createView();

	let expanded = $state(false);
	/** Shared between the sidebar preview and the expanded modal. */
	let showOnlyLinked = $state(false);

	let sidebarWrapEl: HTMLDivElement;
	let sidebarCanvasEl: HTMLCanvasElement;
	let modalWrapEl: HTMLDivElement;
	let modalCanvasEl: HTMLCanvasElement;

	let currentPath = "";

	/** Actual bounding box of every node's current position. */
	function computeBounds() {
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
			minX = 0;
			minY = 0;
			maxX = SIM_SIZE;
			maxY = SIM_SIZE;
		}
		return { minX, minY, maxX, maxY };
	}

	/**
	 * Fit the view so every node is visible (3), based on their real
	 * bounding box rather than an assumed fixed area — physics can push
	 * nodes beyond the nominal SIM_SIZE square, so fitting to SIM_SIZE
	 * alone could clip some of them.
	 */
	function fitView(view: View, force = false) {
		if (view.width <= 0 || view.height <= 0) return;
		const { minX, minY, maxX, maxY } = computeBounds();
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

	/** Recenter (pan only, keep current zoom level) on the current note. */
	function centerOnCurrent(view: View) {
		const n = currentPath ? nodeIndex.get(currentPath) : null;
		if (!n || view.width <= 0 || view.height <= 0) return;
		view.panX = view.width / 2 - n.x * view.scale;
		view.panY = view.height / 2 - n.y * view.scale;
	}

	/** Current note + every note directly linked to it. */
	function getCurrentNeighborIds(): Set<string> {
		const ids = new Set<string>();
		if (!currentPath) return ids;
		ids.add(currentPath);
		for (const l of links) {
			if (l.source === currentPath) ids.add(l.target);
			else if (l.target === currentPath) ids.add(l.source);
		}
		return ids;
	}

	/** Fully restart the layout from scratch — scattered positions, hot
	 * physics, no leftover velocity or drag state. */
	function resetPhysics() {
		for (const n of nodes) {
			n.x = Math.random() * SIM_SIZE;
			n.y = Math.random() * SIM_SIZE;
			n.vx = 0;
			n.vy = 0;
			n.fx = null;
			n.fy = null;
		}
		reheat();
	}

	function toggleFilter() {
		showOnlyLinked = !showOnlyLinked;
		// Entirely reset the display, zoom, and physics — not just reheat —
		// so switching between "all notes" and "only linked" always starts
		// from a clean slate instead of continuing the previous layout.
		resetPhysics();
		sidebarView.userAdjusted = false;
		modalView.userAdjusted = false;
		fitView(sidebarView, true);
		if (expanded) fitView(modalView, true);
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	function draw(view: View, isModal: boolean, now: number) {
		if (!view.canvas || view.width <= 0 || view.height <= 0) return;
		const ctx = view.canvas.getContext("2d");
		if (!ctx) return;

		// The animation's positional offset is a big-view-only effect
		// (standalone page + popup modal, never the small sidebar preview)
		// and purely visual — it never touches n.x/n.y, so this is the only
		// place it exists.
		function drawPos(n: GNode): { x: number; y: number } {
			if (!isModal) return { x: n.x, y: n.y };
			const off = activeAnimation?.getOffset?.(n, now);
			if (!off) return { x: n.x, y: n.y };
			return { x: n.x + off.dx, y: n.y + off.dy };
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

		const style = getComputedStyle(document.body);
		const colorEdge =
			style.getPropertyValue("--text-faint").trim() || "#666";
		const colorNode =
			style.getPropertyValue("--text-muted").trim() || "#888";
		const colorActive =
			style.getPropertyValue("--interactive-accent").trim() || "#7b6cd9";
		const colorLabel =
			style.getPropertyValue("--text-normal").trim() || "#ddd";
		const colorBg =
			style.getPropertyValue("--background-primary").trim() || "#1a1a1a";

		const dimDt = lastDimFrameTime > 0 ? now - lastDimFrameTime : 16;
		lastDimFrameTime = now;

		const neighborIds = getCurrentNeighborIds();
		// Filter (2): restrict to current note + its direct neighbors.
		const visibleIds = showOnlyLinked ? neighborIds : null;

		const hovered = view.hoveredId ? nodeIndex.get(view.hoveredId) : null;
		const linkedToHovered = new Set<string>();
		if (hovered) {
			linkedToHovered.add(hovered.id);
			for (const l of links) {
				if (l.source === hovered.id) linkedToHovered.add(l.target);
				if (l.target === hovered.id) linkedToHovered.add(l.source);
			}
		}

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
		// hovered note.
		for (const l of links) {
			const s = nodeIndex.get(l.source);
			const t = nodeIndex.get(l.target);
			if (!s || !t) continue;
			if (!s.revealed || !t.revealed) continue;
			if (visibleIds && !(visibleIds.has(s.id) && visibleIds.has(t.id)))
				continue;
			const isHighlighted =
				!!hovered && (s.id === hovered.id || t.id === hovered.id);
			ctx.strokeStyle = isHighlighted ? colorActive : colorEdge;
			ctx.globalAlpha = isHighlighted ? 1 : 0.65;
			ctx.lineWidth = (isHighlighted ? 1.8 : 1.1) / view.scale;
			const sp = drawPos(s);
			const tp = drawPos(t);
			ctx.beginPath();
			ctx.moveTo(sp.x, sp.y);
			ctx.lineTo(tp.x, tp.y);
			ctx.stroke();
		}

		// Nodes — draw the current note LAST (in its own pass) so it always
		// sits on top of everything else, with a halo — but sized the same
		// as everyone else, purely by degree (not because it's "the" note).
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
			// Size depends only on how many links a note has.
			const baseR = (3.5 + Math.min(n.degree, 6) * 0.55) / view.scale;
			const intensity = activeAnimation?.getIntensity?.(n, now) ?? 0;
			const r = baseR * ease * animationScale(n, now);
			const p = drawPos(n);

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

			ctx.globalAlpha = n.dimAlpha * ease;
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.fillStyle = isHovered ? colorLabel : colorNode;
			ctx.fill();

			if (isHovered) {
				ctx.lineWidth = 2 / view.scale;
				ctx.strokeStyle = colorBg;
				ctx.stroke();
			}

			const labelA = getLabelAlpha(n);
			if (labelA !== null) {
				ctx.globalAlpha = Math.min(labelA, n.dimAlpha) * ease;
				ctx.font = `${11 / view.scale}px system-ui, sans-serif`;
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
				((3.5 + Math.min(currentNode.degree, 6) * 0.55) / view.scale) *
				ease *
				animationScale(currentNode, now);
			const p = drawPos(currentNode);
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

	// ── Animation loop ───────────────────────────────────────────────────────

	/** Reveals the next node in `revealOrder`, if it's due. Standalone only. */
	function advanceReveal(now: number) {
		if (!standalone || revealCursor >= revealOrder.length) return;
		if (nextRevealAt === 0) nextRevealAt = now; // reveal the first node immediately
		if (now < nextRevealAt) return;
		const n = nodeIndex.get(revealOrder[revealCursor++]);
		if (n) {
			n.revealed = true;
			n.revealedAt = now;
		}
		nextRevealAt = now + REVEAL_STEP_MS;
	}

	let nextAnimationAt = 0; // 0 = not yet scheduled

	/** Schedules/fires the selected periodic animation (see activeAnimation
	 * above), if any. Big-view-only (standalone + modal). */
	function advanceAnimation(now: number, active: boolean) {
		if (!activeAnimation || !active) {
			nextAnimationAt = 0;
			return;
		}
		// Standalone waits for the reveal to finish first; the popup modal
		// has no reveal phase, so it's ready as soon as it's open.
		const ready = standalone ? revealCursor >= revealOrder.length : true;
		if (!ready) return;

		// An animation can define its own cadence (e.g. flicker runs more
		// often than the shared default) — fall back to the shared interval
		// when it doesn't.
		const intervalMs =
			(activeAnimation.intervalSeconds ?? ANIMATION_INTERVAL_SECONDS) *
			1000;

		if (nextAnimationAt === 0) {
			nextAnimationAt = now + intervalMs;
			return;
		}
		if (now < nextAnimationAt) return;

		const current = currentPath ? nodeIndex.get(currentPath) : null;
		activeAnimation.trigger({
			now,
			nodes,
			currentNode: !standalone ? (current ?? null) : null,
			standalone,
			simCenter: { x: SIM_SIZE / 2, y: SIM_SIZE / 2 },
		});
		nextAnimationAt = now + intervalMs;
	}

	let rafId = 0;
	function tick() {
		try {
			// Local, alpha-independent nudge for whichever node is actively
			// being dragged — see applyDragRepulsion's own comment for why
			// this isn't just reheat().
			if (sidebarView.dragNode) applyDragRepulsion(sidebarView.dragNode);
			if (modalView.dragNode) applyDragRepulsion(modalView.dragNode);

			// Always run: alpha has a small floor (never hits exactly 0) and
			// the minimum-separation constraint must hold permanently, not
			// just while "settling" — see (2) and (3).
			step();
			enforceSeparation();

			const stillMoving = alpha > 0.02;
			const now = performance.now();
			advanceReveal(now);

			if (standalone) {
				// Full-page mode: only the big view exists, always active.
				if (stillMoving && !modalView.dragNode) fitView(modalView);
				advanceAnimation(now, true);
				draw(modalView, true, now);
			} else {
				// Keep the default (non-user-adjusted) view fitted to every
				// node while the layout is still moving into place (3) —
				// but never while that view's own drag is in progress, or
				// dragging a node out of frame would resize/pan the window (2).
				if (!expanded && stillMoving && !sidebarView.dragNode) {
					fitView(sidebarView);
				}
				if (expanded && stillMoving && !modalView.dragNode) {
					fitView(modalView);
				}
				advanceAnimation(now, expanded);
				// The small preview is disabled while the big view is open —
				// no point drawing/hit-testing a view the user can't
				// interact with anyway (it sits behind the modal backdrop).
				if (!expanded) draw(sidebarView, false, now);
				else draw(modalView, true, now);
			}
		} catch (err) {
			// Never let one bad frame permanently kill the whole graph —
			// log it so it's visible in the browser console, but keep
			// scheduling the next frame regardless.
			console.error("[Graph view] render error:", err);
		}
		rafId = requestAnimationFrame(tick);
	}

	// ── Coordinate helpers ───────────────────────────────────────────────────

	function toWorld(view: View, clientX: number, clientY: number) {
		const rect = view.canvas!.getBoundingClientRect();
		const sx = clientX - rect.left;
		const sy = clientY - rect.top;
		return {
			x: (sx - view.panX) / view.scale,
			y: (sy - view.panY) / view.scale,
		};
	}

	function nodeAt(view: View, wx: number, wy: number): GNode | null {
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

	// ── Sidebar interactions: hover, click to navigate, AND drag (5) ────────

	function handleSidebarPointerDown(e: PointerEvent) {
		const { x, y } = toWorld(sidebarView, e.clientX, e.clientY);
		const hit = nodeAt(sidebarView, x, y);
		sidebarView.moved = false;
		sidebarView.lastX = e.clientX;
		sidebarView.lastY = e.clientY;
		if (hit) {
			sidebarView.dragNode = hit;
			hit.fx = hit.x;
			hit.fy = hit.y;
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		}
	}

	function handleSidebarPointerMove(e: PointerEvent) {
		if (sidebarView.dragNode) {
			const dx = e.clientX - sidebarView.lastX;
			const dy = e.clientY - sidebarView.lastY;
			// No reheat() here on purpose: that would ramp alpha back up and
			// reactivate repulsion/spring/center forces for every pair in the
			// graph, not just around the dragged node — a global reshuffle
			// instead of a local one. enforceSeparation() (unconditional,
			// every frame, in tick()) already pushes apart anything that
			// ends up too close to the dragged node's new position — that's
			// the only reaction wanted here.
			if (!sidebarView.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
				sidebarView.moved = true;
			}
			const { x, y } = toWorld(sidebarView, e.clientX, e.clientY);
			sidebarView.dragNode.fx = x;
			sidebarView.dragNode.fy = y;
			sidebarView.lastX = e.clientX;
			sidebarView.lastY = e.clientY;
			return;
		}
		const { x, y } = toWorld(sidebarView, e.clientX, e.clientY);
		const hit = nodeAt(sidebarView, x, y);
		sidebarView.hoveredId = hit ? hit.id : null;
		sidebarCanvasEl.style.cursor = hit ? "pointer" : "default";
	}

	/**
	 * Navigate to a node and, if the graph was showing everything, switch to
	 * "only linked" so the view immediately focuses on that note and its
	 * direct links (2). If already filtered, the neighbor set recalculates
	 * on its own once currentPath updates — nothing extra to do there.
	 */
	function focusOnNode(id: string) {
		// `id` is the base-less canonical route (see node ids) — goto()
		// needs the real site base prepended, same as any other href.
		goto(base + id);
		if (!showOnlyLinked) showOnlyLinked = true;
	}

	function handleSidebarPointerUp() {
		if (sidebarView.dragNode) {
			if (!sidebarView.moved) focusOnNode(sidebarView.dragNode.id);
			sidebarView.dragNode.fx = null;
			sidebarView.dragNode.fy = null;
			sidebarView.dragNode = null;
		}
	}

	function handleSidebarLeave() {
		sidebarView.hoveredId = null;
	}

	// ── Modal interactions: hover, click, drag node, drag-to-pan, zoom ──────

	function handleModalPointerDown(e: PointerEvent) {
		const { x, y } = toWorld(modalView, e.clientX, e.clientY);
		const hit = nodeAt(modalView, x, y);
		modalView.moved = false;
		modalView.lastX = e.clientX;
		modalView.lastY = e.clientY;
		if (hit) {
			modalView.dragNode = hit;
			hit.fx = hit.x;
			hit.fy = hit.y;
		} else {
			modalView.isPanning = true;
		}
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handleModalPointerMove(e: PointerEvent) {
		const dxScreen = e.clientX - modalView.lastX;
		const dyScreen = e.clientY - modalView.lastY;
		// No reheat() here on purpose: that would ramp alpha back up and
		// reactivate repulsion/spring/center forces for every pair in the
		// graph, not just around the dragged node — a global reshuffle
		// instead of a local one. enforceSeparation() (unconditional, every
		// frame, in tick()) already pushes apart anything that ends up too
		// close to the dragged node's new position — that's the only
		// reaction wanted here.
		if (!modalView.moved && (Math.abs(dxScreen) > 2 || Math.abs(dyScreen) > 2)) {
			modalView.moved = true;
		}

		if (modalView.dragNode) {
			const { x, y } = toWorld(modalView, e.clientX, e.clientY);
			modalView.dragNode.fx = x;
			modalView.dragNode.fy = y;
		} else if (modalView.isPanning) {
			modalView.panX += dxScreen;
			modalView.panY += dyScreen;
			modalView.userAdjusted = true;
		} else {
			const { x, y } = toWorld(modalView, e.clientX, e.clientY);
			const hit = nodeAt(modalView, x, y);
			modalView.hoveredId = hit ? hit.id : null;
			modalCanvasEl.style.cursor = hit ? "pointer" : "grab";
		}
		modalView.lastX = e.clientX;
		modalView.lastY = e.clientY;
	}

	function handleModalPointerUp() {
		if (modalView.dragNode) {
			if (!modalView.moved) focusOnNode(modalView.dragNode.id);
			modalView.dragNode.fx = null;
			modalView.dragNode.fy = null;
			modalView.dragNode = null;
		}
		modalView.isPanning = false;
	}

	/** Zoom `view` at a screen point, keeping that point fixed under the cursor. */
	function zoomAt(
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

	function handleSidebarWheel(e: WheelEvent) {
		e.preventDefault();
		zoomAt(sidebarView, e.clientX, e.clientY, e.deltaY);
	}

	function handleModalWheel(e: WheelEvent) {
		e.preventDefault();
		zoomAt(modalView, e.clientX, e.clientY, e.deltaY);
	}

	function openModal() {
		expanded = true;
	}
	function closeModal() {
		expanded = false;
	}
	function handleKeydown(e: KeyboardEvent) {
		if (expanded && e.key === "Escape") closeModal();
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	let unsubscribePage: () => void;
	let sidebarResizeObserver: ResizeObserver;

	onMount(() => {
		unsubscribePage = page.subscribe((p) => {
			// $page.url.pathname is URL-encoded by the browser (spaces become
			// "%20", accented/special chars may be encoded too) and includes
			// the site's base path in production, but node ids are the
			// literal, base-less characters straight from the folder names
			// on disk — toRoutePath() undoes both. Without it, a route like
			// "Sessions du Masque" would never match "Sessions%20du%20Masque"
			// (or, deployed under a subpath, nothing would ever match at
			// all), breaking every current-note-dependent feature
			// (highlight, neighbor labels, the "only linked" filter).
			currentPath = toRoutePath(p.url.pathname);
			// (1) Reload the physics and recenter on the note we just
			// navigated to — whether that came from clicking a node in the
			// graph or any other kind of navigation.
			reheat();
			if (!standalone) centerOnCurrent(sidebarView);
			centerOnCurrent(modalView);
		});

		if (!standalone) {
			sidebarView.canvas = sidebarCanvasEl;
			sidebarResizeObserver = new ResizeObserver(() => {
				sidebarView.width = sidebarWrapEl.clientWidth;
				sidebarView.height = sidebarWrapEl.clientHeight;
				fitView(sidebarView); // respects a manual zoom, if any (2)
			});
			sidebarResizeObserver.observe(sidebarWrapEl);
		}

		rafId = requestAnimationFrame(tick);
	});

	onDestroy(() => {
		unsubscribePage?.();
		sidebarResizeObserver?.disconnect();
		if (rafId) cancelAnimationFrame(rafId);
	});

	// Set up (and tear down) the big view's own canvas + resize observer
	// whenever it's actually on screen — either the popup modal is open, or
	// this component is being used in standalone (full-page) mode.
	$effect(() => {
		const active = standalone || expanded;
		if (!active || !modalWrapEl || !modalCanvasEl) return;
		modalView.canvas = modalCanvasEl;
		modalView.userAdjusted = false;
		const ro = new ResizeObserver(() => {
			modalView.width = modalWrapEl.clientWidth;
			modalView.height = modalWrapEl.clientHeight;
			fitView(modalView);
		});
		ro.observe(modalWrapEl);
		return () => ro.disconnect();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet filterButton()}
	<button
		class="clickable-icon"
		class:is-active={showOnlyLinked}
		title={showOnlyLinked
			? "Show all notes"
			: "Show only notes linked to the current one"}
		aria-label="Toggle showing only linked notes"
		onclick={toggleFilter}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="svg-icon"
		>
			<polygon
				points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"
				fill="none"
			/>
		</svg>
	</button>
{/snippet}

<!-- Shared by the standalone full page and the popup modal — both drive
     the same `modalView`/`modalWrapEl`/`modalCanvasEl` and only ever show
     one at a time, so there's no risk of the bind:this targets colliding. -->
{#snippet bigGraphCanvas()}
	<div class="graph-modal-canvas-wrap" bind:this={modalWrapEl}>
		<canvas
			bind:this={modalCanvasEl}
			class="graph-modal-canvas"
			onpointerdown={handleModalPointerDown}
			onpointermove={handleModalPointerMove}
			onpointerup={handleModalPointerUp}
			onpointerleave={handleModalPointerUp}
			onwheel={handleModalWheel}
		></canvas>
		<div class="graph-modal-hint">
			Scroll to zoom · drag background to pan · drag a node to move it ·
			click a node to open it
		</div>
	</div>
{/snippet}

{#if standalone}
	<div class="graph-page">
		<div class="graph-modal-header">
			<h1 class="graph-modal-title graph-page-title">Graph view</h1>
		</div>
		{@render bigGraphCanvas()}
	</div>
{:else}
	<div class="graph-wrap">
		<div class="graph-header">
			<span class="graph-title">Graph view</span>
			<div class="graph-header-actions">
				{@render filterButton()}
				<button
					class="clickable-icon"
					title="Expand graph view"
					aria-label="Expand graph view"
					onclick={openModal}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="svg-icon"
					>
						<path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path
							d="M21 3l-7 7"
						/><path d="M3 21l7-7" />
					</svg>
				</button>
			</div>
		</div>
		<div
			class="graph-canvas-wrap"
			class:is-disabled={expanded}
			bind:this={sidebarWrapEl}
		>
			<canvas
				bind:this={sidebarCanvasEl}
				class="graph-canvas"
				onpointerdown={handleSidebarPointerDown}
				onpointermove={handleSidebarPointerMove}
				onpointerup={handleSidebarPointerUp}
				onpointerleave={handleSidebarLeave}
				onwheel={handleSidebarWheel}
			></canvas>
		</div>
	</div>

	{#if expanded}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="graph-modal-backdrop" onclick={closeModal}>
			<div class="graph-modal" onclick={(e) => e.stopPropagation()}>
				<div class="graph-modal-header">
					<span class="graph-modal-title">Graph view</span>
					<div class="graph-modal-actions">
						{@render filterButton()}
						<button
							class="clickable-icon"
							title="Close"
							aria-label="Close graph view"
							onclick={closeModal}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								class="svg-icon"
							>
								<line x1="18" y1="6" x2="6" y2="18" /><line
									x1="6"
									y1="6"
									x2="18"
									y2="18"
								/>
							</svg>
						</button>
					</div>
				</div>
				{@render bigGraphCanvas()}
			</div>
		</div>
	{/if}
{/if}

<style>
	/* .graph-page's own header/canvas-wrap reuse .graph-modal-header and
	   .graph-modal-canvas-wrap below — same look, one set of rules. */
	.graph-page {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	.graph-page-title {
		margin: 0;
	}

	.graph-wrap {
		padding: 8px 10px 4px;
	}

	.graph-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}

	.graph-title {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.graph-header-actions {
		display: flex;
		gap: 2px;
	}

	.clickable-icon.is-active {
		color: var(--interactive-accent);
	}

	.graph-canvas-wrap {
		width: 100%;
		height: 190px;
		border-radius: 6px;
		overflow: hidden;
		/* Same variable the big view's .graph-modal uses below — --background-
		   primary-alt is inconsistently (or never) redefined per light/dark
		   by some themes, which left this wrapper stuck on a dark fallback
		   even in Light mode. */
		background: var(--background-primary);
	}

	.graph-canvas-wrap.is-disabled {
		opacity: 0.4;
		pointer-events: none;
	}

	.graph-canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.graph-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 10000;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		animation: graph-fade-in 0.12s ease;
	}

	@keyframes graph-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.graph-modal {
		width: min(92vw, 1100px);
		height: min(85vh, 800px);
		display: flex;
		flex-direction: column;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 10px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
		overflow: hidden;
	}

	.graph-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--background-modifier-border);
		flex-shrink: 0;
	}

	.graph-modal-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text-normal);
	}

	.graph-modal-actions {
		display: flex;
		gap: 4px;
	}

	.graph-modal-canvas-wrap {
		position: relative;
		flex: 1;
		overflow: hidden;
	}

	.graph-modal-canvas {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
	}

	.graph-modal-hint {
		position: absolute;
		left: 50%;
		bottom: 10px;
		transform: translateX(-50%);
		font-size: 0.75rem;
		color: var(--text-faint);
		background: var(--background-primary);
		padding: 4px 10px;
		border-radius: 12px;
		border: 1px solid var(--background-modifier-border);
		pointer-events: none;
		white-space: nowrap;
	}
</style>
