import type { GNode } from "../graphTypes";
import type { GraphAnimation } from "./types";

export const label = "Flicker (random node twinkle)";

// A loose, irregular sprinkle of random nodes briefly growing then settling
// back to normal — unlike raindrop.ts, purely independent of one another:
// several can be mid-grow at once, or none at all for a moment. Every tick
// there's a chance (not a certainty) of spawning one more, which is what
// gives the whole thing its irregular, organic pacing instead of a fixed
// rhythm.
const TICK_SECONDS = 0.2; // how often we roll the dice on spawning a new pulse
const SPAWN_CHANCE = 0.5; // per tick
const MAX_GAP_MS = 500; // hard cap — a spawn is forced once idle time reaches this, so gaps never run longer
const DURATION_MIN_MS = 500;
const DURATION_MAX_MS = 950;
const PEAK_MIN = 0.4; // smallest random peak size (fraction of full growth)
const PEAK_MAX = 1; // largest random peak size

/** Zero velocity at both t=0 and t=1 — a soft start and a soft arrival. */
function smoothstep(t: number): number {
	const c = Math.min(1, Math.max(0, t));
	return c * c * (3 - 2 * c);
}

interface Pulse {
	node: GNode;
	start: number;
	duration: number;
	peak: number;
}

/** 0 → 1 over the first half of `duration`, then 1 → 0 over the second. */
function envelope(local: number, duration: number): number {
	const half = duration / 2;
	if (local < half) return smoothstep(local / half);
	return 1 - smoothstep((local - half) / half);
}

let pulses: Pulse[] = [];
let lastSpawnAt = -Infinity;

const flicker: GraphAnimation = {
	label,
	intervalSeconds: TICK_SECONDS,

	trigger(ctx) {
		// Drop anything that's fully finished so the list doesn't grow
		// forever across a long-open graph view.
		pulses = pulses.filter((p) => ctx.now - p.start <= p.duration);

		const idleMs = ctx.now - lastSpawnAt;
		// Normally it's a coin flip whether this tick spawns anything at all
		// (that's the "sometimes silence" pacing) — but once idle time hits
		// MAX_GAP_MS, force one so the quiet stretch never runs any longer.
		if (idleMs < MAX_GAP_MS && Math.random() > SPAWN_CHANCE) return;

		const pool = ctx.nodes.filter((n) => n.revealed);
		if (!pool.length) return;
		const node = pool[Math.floor(Math.random() * pool.length)];
		lastSpawnAt = ctx.now;
		pulses.push({
			node,
			start: ctx.now,
			duration:
				DURATION_MIN_MS + Math.random() * (DURATION_MAX_MS - DURATION_MIN_MS),
			peak: PEAK_MIN + Math.random() * (PEAK_MAX - PEAK_MIN),
		});
	},

	getIntensity(n: GNode, now: number) {
		// A node can only be mid-pulse once at a time in practice, but if two
		// happened to land on the same node, the strongest one wins.
		let best = 0;
		for (const p of pulses) {
			if (p.node.id !== n.id) continue;
			const local = now - p.start;
			if (local < 0 || local > p.duration) continue;
			const v = p.peak * envelope(local, p.duration);
			if (v > best) best = v;
		}
		return best;
	},
};

export default flicker;
