import type { GNode } from "../graphTypes";

/** Passed to a GraphAnimation's trigger() every time a new cycle starts. */
export interface AnimationTriggerContext {
	now: number;
	nodes: GNode[];
	/** The currently-open note's node — null in standalone mode (the
	 * full-page graph has no "current" focal note) or if none is open. */
	currentNode: GNode | null;
	/** True for the full-page standalone graph; false for the popup modal. */
	standalone: boolean;
	/** Center of the simulation space — the natural fallback origin. */
	simCenter: { x: number; y: number };
}

/**
 * One selectable graph-view animation. Drop a file default-exporting one of
 * these into lib/animations/ and it's automatically picked up by
 * lib/animationRegistry.ts — no registration needed elsewhere. The filename
 * (without extension) becomes the animation's id, which is what gets stored
 * in the plugin's "Graph animation" setting and graphConfig.json.
 *
 * Both hooks are purely visual: neither should ever mutate `node.x`/`node.y`
 * (that would make the physics simulation itself drift), only return an
 * offset/intensity for the renderer to apply at draw time.
 */
export interface GraphAnimation {
	/** Human-readable name shown in the plugin's settings dropdown. */
	label: string;
	/** Seconds between cycles for this animation specifically. Optional —
	 * falls back to the shared ANIMATION_INTERVAL_SECONDS (graphConfig.ts)
	 * when omitted, so most animations don't need to set this at all. */
	intervalSeconds?: number;
	/** (Re)starts the effect — called once per animation cycle. */
	trigger(ctx: AnimationTriggerContext): void;
	/** Sim-space (dx, dy) to draw `node` offset by at time `now`. Optional —
	 * omit if this animation doesn't move nodes (e.g. a pure glow/size effect). */
	getOffset?(node: GNode, now: number): { dx: number; dy: number };
	/** 0..1 "how lit up" `node` is at time `now`; the renderer uses this to
	 * scale its radius (growing it) and draw a glow. Optional — omit if this
	 * animation doesn't highlight individual nodes, or use getSizeScale
	 * instead if it needs to shrink a node rather than just grow it. */
	getIntensity?(node: GNode, now: number): number;
	/** Direct radius multiplier for `node` at time `now` (1 = normal size,
	 * <1 shrinks it, >1 grows it). Optional — when present, takes priority
	 * over getIntensity for sizing (but getIntensity still separately drives
	 * the glow halo, if any). Use this instead of getIntensity when an
	 * animation needs to shrink a node, not just grow it. */
	getSizeScale?(node: GNode, now: number): number;
}
