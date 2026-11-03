import { riseFall } from "../easing";
import type { GNode } from "../graphTypes";
import type { GraphAnimation } from "./types";

export const label = "Heartbeat (shockwave pulse)";

// A purely visual, physics-independent nudge: an expanding wavefront
// travels outward from an origin at a finite speed, and each node only
// gets its own brief push-then-return once the wavefront actually reaches
// it — not all nodes moving in lockstep. The underlying simulation x/y
// never change, so there's no risk of the layout actually drifting.
const WAVE_SPEED = 0.22; // sim-space units per ms the wavefront travels
const PUSH_MS = 380; // gentle rise to the crest
const RETURN_MS = 1400; // slower, gentle settle back to rest
const LOCAL_MS = PUSH_MS + RETURN_MS;
const MAX_PUSH = 4; // px at the peak, right where the wavefront currently is

let origin: { x: number; y: number } | null = null;
let startTime = 0;
/** How long the wave stays relevant for — time to reach the farthest node,
 * plus one local push-and-return. Computed per-trigger from actual node
 * distances so it always fully clears the graph regardless of layout. */
let activeMs = 0;

const heartbeat: GraphAnimation = {
	trigger(ctx) {
		origin = ctx.currentNode
			? { x: ctx.currentNode.x, y: ctx.currentNode.y }
			: ctx.simCenter;
		startTime = ctx.now;
		let maxDist = 0;
		for (const n of ctx.nodes) {
			const dx = n.x - origin.x;
			const dy = n.y - origin.y;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d > maxDist) maxDist = d;
		}
		activeMs = maxDist / WAVE_SPEED + LOCAL_MS;
	},

	getOffset(n: GNode, now: number) {
		if (!origin) return { dx: 0, dy: 0 };
		const elapsed = now - startTime;
		if (elapsed < 0 || elapsed > activeMs) return { dx: 0, dy: 0 };

		const ddx = n.x - origin.x;
		const ddy = n.y - origin.y;
		const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;

		// The wavefront reaches this node at `arrival`; its own push-and-
		// return happens in the LOCAL_MS window after that — this is what
		// makes it a traveling wave rather than a synchronized pulse: two
		// nodes at different distances peak at different times.
		const arrival = dist / WAVE_SPEED;
		const local = elapsed - arrival;
		if (local < 0 || local > LOCAL_MS) return { dx: 0, dy: 0 };

		// A gentle rise, then a much slower return — a rolling swell
		// rather than a jolt.
		const push = MAX_PUSH * riseFall(local, PUSH_MS, RETURN_MS);
		return { dx: (ddx / dist) * push, dy: (ddy / dist) * push };
	},
};

export default heartbeat;
