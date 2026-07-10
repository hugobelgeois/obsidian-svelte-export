import type { GraphAnimation } from "./animations/types";

// Eager glob instead of hand-written imports: every file under
// lib/animations/ that default-exports a GraphAnimation is automatically
// registered below, keyed by its filename (without extension). Add a new
// file there (or delete one) and the graph view's available animations
// change on the next build — nothing else in the app needs to know about
// it. `types.ts` has no default export so it's naturally skipped.
const modules = import.meta.glob<{ default?: GraphAnimation }>(
	"./animations/*.ts",
	{ eager: true },
);

export const animationRegistry = new Map<string, GraphAnimation>();
for (const [filePath, mod] of Object.entries(modules)) {
	if (!mod.default) continue;
	const id = filePath.match(/([^/]+)\.ts$/)?.[1];
	if (id) animationRegistry.set(id, mod.default);
}

/** Picks one animation id at random from whatever's currently registered —
 * backs the "Random" choice in the plugin's animation setting, so a new
 * file dropped into lib/animations/ is automatically eligible without any
 * other change needed. */
export function randomAnimationId(): string | undefined {
	const ids = [...animationRegistry.keys()];
	if (!ids.length) return undefined;
	return ids[Math.floor(Math.random() * ids.length)];
}
