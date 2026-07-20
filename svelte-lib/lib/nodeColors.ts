// import.meta.glob instead of a static `import ... from "$lib/nodeColors.json"`:
// a static import fails the whole Vite build if the file doesn't exist yet
// (e.g. right after updating the plugin's svelte-lib files but before the
// very first export has run). The glob form simply returns an empty result
// set instead of erroring.
const modules = import.meta.glob("./nodeColors.json", {
	eager: true,
}) as Record<string, { default?: Record<string, string> }>;

/** Route → hex color, from Obsidian's own graph "Groups" — see
 * computeNodeColors() in the plugin's src/graphColors.ts, which writes
 * nodeColors.json at export time. Routes with no matching group are simply
 * absent (the graph view falls back to its default node color for them). */
export const NODE_COLORS: Record<string, string> =
	Object.values(modules)[0]?.default ?? {};
