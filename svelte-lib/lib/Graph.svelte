<script lang="ts">
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { animationRegistry, randomAnimationId } from "$lib/animationRegistry";
	import {
		ANIMATION_INTERVAL_SECONDS,
		ANIMATION_TYPE,
		GRAPH_FORCES,
		NODE_COLORS,
	} from "$lib/exportData";
	import {
		DIM_TAU_MS,
		drawGraph,
		REVEAL_FADE_MS,
		withNeighbors,
		type GraphColors,
	} from "$lib/graphDraw";
	import { DRAG_ALPHA, ForceSimulation, seedPositions } from "$lib/graphPhysics";
	import type { GNode } from "$lib/graphTypes";
	import {
		centerOn,
		createView,
		fitView,
		nodeAt,
		toWorld,
		zoomAt,
		type View,
	} from "$lib/graphView";
	import { getLinkEdges } from "$lib/linkGraph";
	import { toRoutePath } from "$lib/routePath";
	import Icon from "$lib/Icon.svelte";
	import { flattenTree, siteTree } from "$lib/siteTree";
	import { onDestroy, onMount, untrack } from "svelte";

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
	 * the ordering issue of a child trying to signal an ancestor.
	 * Read once: a page never switches modes after it's created. */
	const props: { standalone?: boolean } = $props();
	const standalone = untrack(() => props.standalone ?? false);

	// ── Types ────────────────────────────────────────────────────────────────

	interface GLink {
		source: string;
		target: string;
	}

	// ── Graph data (structure is static — built once) ───────────────────────

	const files = flattenTree(siteTree);

	const nodes: GNode[] = files.map((f) => ({
		id: f.path,
		label: f.name,
		x: 0, // placed by seedPositions() below
		y: 0,
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

	/** Node id → ids of every node it's directly linked to. */
	const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
	for (const l of links) {
		adjacency.get(l.source)!.push(l.target);
		adjacency.get(l.target)!.push(l.source);
		nodeIndex.get(l.source)!.degree++;
		nodeIndex.get(l.target)!.degree++;
	}

	/** Every link, as the nodes it joins — for the physics and drawing. */
	const edges = links.map((l) => ({
		source: nodeIndex.get(l.source)!,
		target: nodeIndex.get(l.target)!,
	}));

	// ── Progressive reveal (standalone page only) ───────────────────────────
	// Order: the most-connected node first, then its neighbors (breadth-
	// first, each frontier visited most-connected-first), so the reveal
	// grows outward from each "hub" the same way the eye would explore the
	// graph. Once a whole connected component is exhausted, jump to the
	// next most-connected node not yet reached (covers disconnected notes).
	function computeRevealOrder(): string[] {
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
	let revealCursor = 0;
	let nextRevealAt = 0;

	/** Previous frame's time, for the hover dimming's easing. */
	let lastDimFrameTime = 0;

	// ── Physics ──────────────────────────────────────────────────────────────
	// Obsidian's own graph simulation, with the force settings from the
	// vault's graph view — see lib/graphPhysics.ts.

	const sim = new ForceSimulation(nodes, edges, GRAPH_FORCES);
	seedPositions(nodes, (id) => adjacency.get(id) ?? [], nodeIndex);

	// ── Views & shared display state ─────────────────────────────────────────

	const sidebarView = createView();
	const modalView = createView();

	let expanded = $state(false);
	/** Shared between the sidebar preview and the expanded modal. */
	let showOnlyLinked = $state(false);

	let sidebarWrapEl: HTMLDivElement | undefined = $state();
	let sidebarCanvasEl: HTMLCanvasElement | undefined = $state();
	let modalWrapEl: HTMLDivElement;
	let modalCanvasEl: HTMLCanvasElement;

	let currentPath = "";
	/** Current note + its direct links — recomputed on navigation only. */
	let currentNeighbors = new Set<string>();

	/** Recenter (pan only, keep current zoom level) on the current note. */
	function centerOnCurrent(view: View) {
		centerOn(view, currentPath ? nodeIndex.get(currentPath) : null);
	}

	/** Fully restart the layout from scratch — freshly placed nodes, hot
	 * physics, no leftover velocity or drag state. */
	function resetPhysics() {
		seedPositions(nodes, (id) => adjacency.get(id) ?? [], nodeIndex);
		sim.alpha = 1;
		sim.alphaTarget = 0;
		wake();
	}

	function toggleFilter() {
		showOnlyLinked = !showOnlyLinked;
		// Entirely reset the display, zoom, and physics — not just warm it up —
		// so switching between "all notes" and "only linked" always starts
		// from a clean slate instead of continuing the previous layout.
		resetPhysics();
		sidebarView.userAdjusted = false;
		modalView.userAdjusted = false;
		fitView(sidebarView, nodes, true);
		if (expanded) fitView(modalView, nodes, true);
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	/** Theme colors, read once and cached: getComputedStyle every frame is
	 * costly. Cleared by the <body> class observer in onMount — that's where
	 * the light/dark toggle (theme-dark/theme-light) lands. */
	let colors: GraphColors | null = null;

	function getColors(): GraphColors {
		if (!colors) {
			const style = getComputedStyle(document.body);
			const read = (name: string, fallback: string) =>
				style.getPropertyValue(name).trim() || fallback;
			colors = {
				colorEdge: read("--text-faint", "#666"),
				colorNode: read("--text-muted", "#888"),
				colorActive: read("--interactive-accent", "#7b6cd9"),
				colorLabel: read("--text-normal", "#ddd"),
				colorBg: read("--background-primary", "#1a1a1a"),
			};
		}
		return colors;
	}

	/** Draws one frame of `view` — see drawGraph() in graphDraw.ts. */
	function draw(view: View, isModal: boolean, now: number) {
		const dimDt = lastDimFrameTime > 0 ? now - lastDimFrameTime : 16;
		lastDimFrameTime = now;
		drawGraph(
			view,
			{
				nodes,
				edges,
				nodeIndex,
				adjacency,
				currentPath,
				currentNeighbors,
				showOnlyLinked,
				animation: activeAnimation,
				nodeColors: NODE_COLORS,
				colors: getColors(),
			},
			isModal,
			now,
			dimDt,
		);
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
			simCenter: { x: 0, y: 0 },
		});
		nextAnimationAt = now + intervalMs;
	}

	// The frame loop only runs while something on screen can change: the
	// simulation running, a drag, a hover fade, the progressive reveal, or a
	// periodic animation in the big view. Otherwise it sleeps, and anything
	// that changes what's drawn calls wake().

	let rafId = 0;
	let destroyed = false;
	/** Keep drawing until this time (performance.now()) at least. */
	let redrawUntil = 0;

	/** Schedules a frame (if none is pending) and keeps frames coming for
	 * `ms` more milliseconds — e.g. long enough for a hover fade to finish. */
	function wake(ms = 0) {
		redrawUntil = Math.max(redrawUntil, performance.now() + ms);
		if (!rafId && !destroyed) rafId = requestAnimationFrame(tick);
	}

	/** Covers a full hover dim/undim fade (~3 × DIM_TAU_MS). */
	const HOVER_FADE_MS = DIM_TAU_MS * 4;

	function tick() {
		rafId = 0;
		const now = performance.now();
		const dragging = !!(sidebarView.dragNode || modalView.dragNode);
		const bigViewActive = standalone || expanded;
		try {
			// Stops by itself once alpha has decayed (~5s after the last
			// disturbance), exactly like Obsidian's.
			sim.tick();

			const stillMoving = sim.alpha > 0.02;
			advanceReveal(now);

			if (standalone) {
				// Full-page mode: only the big view exists, always active.
				if (stillMoving && !modalView.dragNode) fitView(modalView, nodes);
				advanceAnimation(now, true);
				draw(modalView, true, now);
			} else {
				// Keep the default (non-user-adjusted) view fitted to every
				// node while the layout is still moving into place (3) —
				// but never while that view's own drag is in progress, or
				// dragging a node out of frame would resize/pan the window (2).
				if (!expanded && stillMoving && !sidebarView.dragNode) {
					fitView(sidebarView, nodes);
				}
				if (expanded && stillMoving && !modalView.dragNode) {
					fitView(modalView, nodes);
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

		const revealing =
			standalone &&
			(revealCursor < revealOrder.length ||
				now < nextRevealAt + REVEAL_FADE_MS);
		// A periodic animation is time-driven (it moves/glows nodes between
		// triggers), so the big view keeps drawing every frame while one is
		// selected — exactly as before this loop learned to sleep.
		const animating = bigViewActive && !!activeAnimation;
		if (
			sim.running ||
			dragging ||
			revealing ||
			animating ||
			now < redrawUntil
		) {
			wake();
		}
	}

	// ── Pointer interactions ─────────────────────────────────────────────────
	// Both views: hover, click a node to navigate, drag a node (5). The
	// big view (`canPan`) also drags the background to pan.

	function handlePointerDown(view: View, canPan: boolean, e: PointerEvent) {
		const { x, y } = toWorld(view, e.clientX, e.clientY);
		const hit = nodeAt(view, nodes, x, y);
		view.moved = false;
		view.lastX = e.clientX;
		view.lastY = e.clientY;
		if (hit) {
			view.dragNode = hit;
			hit.fx = hit.x;
			hit.fy = hit.y;
		} else if (canPan) {
			view.isPanning = true;
		} else {
			return;
		}
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		wake();
	}

	function handlePointerMove(view: View, canPan: boolean, e: PointerEvent) {
		const dx = e.clientX - view.lastX;
		const dy = e.clientY - view.lastY;
		view.lastX = e.clientX;
		view.lastY = e.clientY;
		if (!view.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
			view.moved = true;
		}

		if (view.dragNode) {
			// Like Obsidian: the simulation stays warm for as long as a
			// node is being dragged, so the rest of the graph follows it.
			const { x, y } = toWorld(view, e.clientX, e.clientY);
			view.dragNode.fx = x;
			view.dragNode.fy = y;
			sim.heat(DRAG_ALPHA);
			sim.alphaTarget = DRAG_ALPHA;
			wake();
		} else if (view.isPanning) {
			view.panX += dx;
			view.panY += dy;
			view.userAdjusted = true;
			wake();
		} else {
			const { x, y } = toWorld(view, e.clientX, e.clientY);
			const hit = nodeAt(view, nodes, x, y);
			setHovered(view, hit ? hit.id : null);
			view.canvas!.style.cursor = hit
				? "pointer"
				: canPan
					? "grab"
					: "default";
		}
	}

	function handlePointerUp(view: View) {
		if (view.dragNode) {
			if (!view.moved) focusOnNode(view.dragNode.id);
			view.dragNode.fx = null;
			view.dragNode.fy = null;
			view.dragNode = null;
			// Released: let the simulation cool down and settle again.
			sim.alphaTarget = 0;
			wake();
		}
		view.isPanning = false;
	}

	function setHovered(view: View, id: string | null) {
		if (view.hoveredId === id) return;
		view.hoveredId = id;
		wake(HOVER_FADE_MS);
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
		showOnlyLinked = true;
		wake();
	}

	function handleWheel(view: View, e: WheelEvent) {
		e.preventDefault();
		zoomAt(view, e.clientX, e.clientY, e.deltaY);
		wake();
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

	let sidebarResizeObserver: ResizeObserver;
	let themeObserver: MutationObserver;

	$effect(() => {
		// page.url.pathname is URL-encoded by the browser (spaces become
		// "%20", accented/special chars may be encoded too) and includes
		// the site's base path in production, but node ids are the
		// literal, base-less characters straight from the folder names
		// on disk — toRoutePath() undoes both. Without it, a route like
		// "Sessions du Masque" would never match "Sessions%20du%20Masque"
		// (or, deployed under a subpath, nothing would ever match at
		// all), breaking every current-note-dependent feature
		// (highlight, neighbor labels, the "only linked" filter).
		const path = toRoutePath(page.url.pathname);
		untrack(() => {
			currentPath = path;
			currentNeighbors = withNeighbors(adjacency, currentPath);
			// (1) Recenter on the note we just navigated to — whether that
			// came from clicking a node in the graph or any other kind of
			// navigation.
			if (!standalone) centerOnCurrent(sidebarView);
			centerOnCurrent(modalView);
			wake();
		});
	});

	onMount(() => {
		if (!standalone && sidebarWrapEl && sidebarCanvasEl) {
			const wrap = sidebarWrapEl;
			sidebarView.canvas = sidebarCanvasEl;
			sidebarResizeObserver = new ResizeObserver(() => {
				sidebarView.width = wrap.clientWidth;
				sidebarView.height = wrap.clientHeight;
				fitView(sidebarView, nodes); // respects a manual zoom, if any (2)
				wake();
			});
			sidebarResizeObserver.observe(wrap);
		}

		// Theme toggles land on <body>'s classes — re-read the colors then.
		themeObserver = new MutationObserver(() => {
			colors = null;
			wake();
		});
		themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});

		wake();
	});

	onDestroy(() => {
		destroyed = true;
		sidebarResizeObserver?.disconnect();
		themeObserver?.disconnect();
		if (rafId) cancelAnimationFrame(rafId);
	});

	// Set up (and tear down) the big view's own canvas + resize observer
	// whenever it's actually on screen — either the popup modal is open, or
	// this component is being used in standalone (full-page) mode.
	$effect(() => {
		const active = standalone || expanded;
		// Opening/closing the popup swaps which canvas is drawn.
		wake();
		if (!active || !modalWrapEl || !modalCanvasEl) return;
		modalView.canvas = modalCanvasEl;
		modalView.userAdjusted = false;
		const ro = new ResizeObserver(() => {
			modalView.width = modalWrapEl.clientWidth;
			modalView.height = modalWrapEl.clientHeight;
			fitView(modalView, nodes);
			wake();
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
		<Icon>
			<polygon
				points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"
				fill="none"
			/>
		</Icon>
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
			onpointerdown={(e) => handlePointerDown(modalView, true, e)}
			onpointermove={(e) => handlePointerMove(modalView, true, e)}
			onpointerup={() => handlePointerUp(modalView)}
			onpointerleave={() => handlePointerUp(modalView)}
			onwheel={(e) => handleWheel(modalView, e)}
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
					<Icon>
						<path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path
							d="M21 3l-7 7"
						/><path d="M3 21l7-7" />
					</Icon>
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
				onpointerdown={(e) => handlePointerDown(sidebarView, false, e)}
				onpointermove={(e) => handlePointerMove(sidebarView, false, e)}
				onpointerup={() => handlePointerUp(sidebarView)}
				onpointerleave={() => setHovered(sidebarView, null)}
				onwheel={(e) => handleWheel(sidebarView, e)}
			></canvas>
		</div>
	</div>

	{#if expanded}
		<!-- Clicking the backdrop (outside the dialog) closes it; Escape and
		     the close button are the keyboard equivalents. -->
		<div
			class="graph-modal-backdrop"
			role="presentation"
			onclick={(e) => e.target === e.currentTarget && closeModal()}
		>
			<div class="graph-modal" role="dialog" aria-modal="true" aria-label="Graph view">
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
							<Icon>
								<line x1="18" y1="6" x2="6" y2="18" /><line
									x1="6"
									y1="6"
									x2="18"
									y2="18"
								/>
							</Icon>
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
