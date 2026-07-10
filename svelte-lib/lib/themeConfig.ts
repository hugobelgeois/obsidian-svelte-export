// import.meta.glob instead of a static `import ... from "$lib/themeConfig.json"`:
// a static import fails the whole Vite build if the file doesn't exist yet
// (e.g. right after updating the plugin's svelte-lib files but before the
// very first export has run). The glob form simply returns an empty result
// set instead of erroring.
const modules = import.meta.glob("./themeConfig.json", {
	eager: true,
}) as Record<string, { default?: { defaultColorMode?: string } }>;

const themeConfig = Object.values(modules)[0]?.default ?? {};

/** Which color mode the exported site starts in on first load — set in the
 * plugin's settings. A visitor's own toggle still overrides this for the
 * rest of their visit (see +layout.svelte). */
export const DEFAULT_COLOR_MODE: "dark" | "light" =
	themeConfig.defaultColorMode === "light" ? "light" : "dark";
