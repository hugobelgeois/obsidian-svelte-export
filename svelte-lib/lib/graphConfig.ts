// import.meta.glob instead of a static `import ... from "$lib/graphConfig.json"`:
// a static import fails the whole Vite build if graphConfig.json doesn't exist
// yet (e.g. right after updating the plugin's svelte-lib files but before the
// very first export has run). The glob form simply returns an empty result
// set instead of erroring.
const graphConfigModules = import.meta.glob("./graphConfig.json", {
	eager: true,
}) as Record<string, { default?: { heartbeatSeconds?: number } }>;

const graphConfig = Object.values(graphConfigModules)[0]?.default ?? {};

/** Seconds between graph-view heartbeat pulses. 0 = disabled. */
export const HEARTBEAT_SECONDS = graphConfig.heartbeatSeconds ?? 10;
