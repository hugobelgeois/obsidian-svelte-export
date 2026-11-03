// Easing helpers shared by the graph animations in lib/animations/ — kept
// out of that folder, where every file is offered as an animation.

/** Zero velocity at both t=0 and t=1 — a soft start and a soft arrival. */
export function smoothstep(t: number): number {
	const c = Math.min(1, Math.max(0, t));
	return c * c * (3 - 2 * c);
}

/** 0 → 1 over `riseMs`, then 1 → 0 over `fallMs` — smoothstep on both legs,
 * so it starts, peaks and ends completely at rest. `local` is the time in
 * ms since the envelope started. */
export function riseFall(local: number, riseMs: number, fallMs: number): number {
	if (local < riseMs) return smoothstep(local / riseMs);
	return 1 - smoothstep((local - riseMs) / fallMs);
}
