import type { GNode } from "../graphTypes";
import type { GraphAnimation } from "./types";

export const label = "Raindrop (shrink/grow pulse with pull & push)";

// Like flicker.ts, drops are independent of one another — several can be
// mid-bounce at once, on different nodes, rather than only ever one at a
// time. Every tick always starts at least one, so there's never more than
// TICK_SECONDS of quiet between triggers.
const TICK_SECONDS = 0.2; // also the max gap between triggers, since every tick spawns something
const MIN_SPAWNS_PER_TICK = 1;
const MAX_SPAWNS_PER_TICK = 2; // 1 to 2 nodes triggered at once, picked fresh each tick

// Each drop bounces like a damped spring: it shrinks abruptly, grows back
// past its normal size, shrinks again (a little less this time), and so
// on — each bounce weaker than the last — until it settles back to rest.
const BEAT_MS = 480; // duration of one shrink or grow phase
const BEAT_COUNT = 6; // 3 shrinks + 3 grows, interleaved, decaying
const DECAY = 0.55; // each beat's amplitude relative to the previous one's
const MAX_SIZE_DELTA = 0.45; // a full-amplitude, full-weight beat is ±45% of normal size
const BEAT_DIP_MS = 110; // quick onset — "all at once"
const BEAT_RETURN_MS = BEAT_MS - BEAT_DIP_MS; // slower ease back to neutral before the next (opposite) beat
const TOTAL_LIFESPAN_MS = BEAT_COUNT * BEAT_MS;

// The bigger a node already is (more links, see sizeWeight() below), the
// deeper it sinks and the harder it impacts its neighbors when it drops.
const SIZE_REF_DEGREE = 6; // degree at which a node is already about as big as it gets (mirrors Graph.svelte's own size cap)
const MIN_WEIGHT = 0.35; // even a totally unlinked node still drops a little

function sizeWeight(n: GNode): number {
	const t = Math.min(n.degree, SIZE_REF_DEGREE) / SIZE_REF_DEGREE;
	return MIN_WEIGHT + (1 - MIN_WEIGHT) * t;
}

/** Zero velocity at both t=0 and t=1 — a soft start and a soft arrival. */
function smoothstep(t: number): number {
	const c = Math.min(1, Math.max(0, t));
	return c * c * (3 - 2 * c);
}

/** Quick dip/rise to the extreme, then a slower ease back to neutral — zero
 * at both ends, so consecutive beats hand off with no jump. */
function beatEnvelope(local: number): number {
	if (local < BEAT_DIP_MS) return smoothstep(local / BEAT_DIP_MS);
	return 1 - smoothstep((local - BEAT_DIP_MS) / BEAT_RETURN_MS);
}

// Each beat also sends a small ripple into nearby nodes: an attracting pull
// during a shrink beat, a repelling push during a grow beat — with the
// same decaying amplitude as the beat itself (and the drop's own size
// weight), so the wave fades out right along with the bounce.
const WAVE_SPEED = 0.4; // sim-space units per ms near the source — decays with distance, see arrivalTime()
const WAVE_MAX_REACH = 55; // sim-space units — the ripple is never felt beyond this
const WAVE_PUSH_MS = 110;
const WAVE_RETURN_MS = 220;
const WAVE_LOCAL_MS = WAVE_PUSH_MS + WAVE_RETURN_MS;
const WAVE_MAX_PUSH = 3; // px at the crest, right at the source, at full amplitude and full weight

/** Time for the ripple to reach `dist` — quadratic, so it's fast right at
 * the source and keeps slowing down the farther it has to travel. */
function arrivalTime(dist: number): number {
	return (dist * dist) / (WAVE_SPEED * WAVE_MAX_REACH);
}

/** 0 → 1 over the gentle rise, then 1 → 0 over the return. */
function waveEnvelope(local: number): number {
	if (local < WAVE_PUSH_MS) return smoothstep(local / WAVE_PUSH_MS);
	return 1 - smoothstep((local - WAVE_PUSH_MS) / WAVE_RETURN_MS);
}

interface Beat {
	sign: -1 | 1; // -1 = shrink + attract, 1 = grow + repel
	start: number; // ms since the drop started
	amplitude: number; // 0..1, decaying beat over beat
}

interface Drop {
	node: GNode;
	start: number;
	beats: Beat[];
	weight: number; // this node's own size weight, fixed for the life of the drop
}

let drops: Drop[] = [];

/** The beat currently playing out for `local` (ms since the drop started), if any. */
function currentBeat(local: number, beats: Beat[]): Beat | null {
	for (const b of beats) {
		if (local >= b.start && local < b.start + BEAT_MS) return b;
	}
	return null;
}

function spawnDrop(now: number, pool: GNode[]) {
	const node = pool[Math.floor(Math.random() * pool.length)];
	const beats: Beat[] = [];
	let amplitude = 1;
	for (let i = 0; i < BEAT_COUNT; i++) {
		beats.push({ sign: i % 2 === 0 ? -1 : 1, start: i * BEAT_MS, amplitude });
		amplitude *= DECAY;
	}
	drops.push({ node, start: now, beats, weight: sizeWeight(node) });
}

const raindrop: GraphAnimation = {
	label,
	intervalSeconds: TICK_SECONDS,

	trigger(ctx) {
		// Drop anything that's fully finished so the list doesn't grow
		// forever across a long-open graph view.
		drops = drops.filter((d) => ctx.now - d.start <= TOTAL_LIFESPAN_MS);

		const pool = ctx.nodes.filter((n) => n.revealed);
		if (!pool.length) return;

		// Always at least one, up to three — randomized count each tick, so
		// it never reads as a strict one-drop-per-tick rhythm.
		const count =
			MIN_SPAWNS_PER_TICK +
			Math.floor(
				Math.random() * (MAX_SPAWNS_PER_TICK - MIN_SPAWNS_PER_TICK + 1),
			);
		for (let i = 0; i < count; i++) spawnDrop(ctx.now, pool);
	},

	getSizeScale(n: GNode, now: number) {
		let scale = 1;
		for (const d of drops) {
			if (d.node.id !== n.id) continue;
			const local = now - d.start;
			const beat = currentBeat(local, d.beats);
			if (!beat) continue;
			const e = beatEnvelope(local - beat.start);
			scale += beat.sign * beat.amplitude * MAX_SIZE_DELTA * d.weight * e;
		}
		return scale;
	},

	getOffset(n: GNode, now: number) {
		let dx = 0;
		let dy = 0;
		for (const d of drops) {
			if (d.node.id === n.id) continue;
			const local = now - d.start;
			const beat = currentBeat(local, d.beats);
			if (!beat) continue;

			const ddx = n.x - d.node.x;
			const ddy = n.y - d.node.y;
			const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
			if (dist > WAVE_MAX_REACH) continue;

			// The ripple reaches this node at `arrival`; its own push-and-
			// return happens in the WAVE_LOCAL_MS window after that — nearer
			// nodes react first, farther ones a beat later.
			const arrival = arrivalTime(dist);
			const waveLocal = local - beat.start - arrival;
			if (waveLocal < 0 || waveLocal > WAVE_LOCAL_MS) continue;

			const t = dist / WAVE_MAX_REACH;
			const ampFalloff = (1 - t) * (1 - t); // weaker the farther out — zero right at the edge
			const push =
				WAVE_MAX_PUSH *
				beat.amplitude *
				d.weight *
				ampFalloff *
				waveEnvelope(waveLocal);

			// Shrinking (sign -1) pulls neighbors in; growing (sign 1) pushes
			// them away — same direction vector, just flipped. Contributions
			// from multiple overlapping drops simply add up.
			dx += (ddx / dist) * push * beat.sign;
			dy += (ddy / dist) * push * beat.sign;
		}
		return { dx, dy };
	},
};

export default raindrop;
