// import.meta.glob instead of a static `import ... from "$lib/graphConfig.json"`:
// a static import fails the whole Vite build if graphConfig.json doesn't exist
// yet (e.g. right after updating the plugin's svelte-lib files but before the
// very first export has run). The glob form simply returns an empty result
// set instead of erroring.
const graphConfigModules = import.meta.glob("./graphConfig.json", {
	eager: true,
}) as Record<string, { default?: { animationType?: string } }>;

const graphConfig = Object.values(graphConfigModules)[0]?.default ?? {};

/** Which periodic animation plays in the graph view's big view (standalone
 * page + popup modal) — "none", "random" (Graph.svelte picks one animation
 * id at random once per page load), or an id matching a filename under
 * lib/animations/ (see lib/animationRegistry.ts). Configured in the plugin
 * settings; the interval itself is fixed below, not user-configurable. */
export const ANIMATION_TYPE: string = graphConfig.animationType ?? "none";

/** Seconds between graph-view animation cycles (heartbeat pulse or flicker
 * burst). */
export const ANIMATION_INTERVAL_SECONDS = 5;
