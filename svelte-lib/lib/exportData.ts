// Data files written next to this module by the plugin at export time (see
// runExport() in the plugin's src/main.ts). import.meta.glob instead of
// static `import ... from "./x.json"`: a static import fails the whole Vite
// build if the file doesn't exist yet (e.g. right after updating the
// plugin's svelte-lib files but before the very first export has run) —
// the glob form simply leaves it out, and the fallback below applies.
const modules = import.meta.glob("./*.json", { eager: true }) as Record<
	string,
	{ default?: unknown }
>;

function load<T>(name: string, fallback: T): T {
	return (modules[`./${name}`]?.default as T | undefined) ?? fallback;
}

const graphConfig = load<{ animationType?: string }>("graphConfig.json", {});
const themeConfig = load<{ defaultColorMode?: string }>("themeConfig.json", {});

/** Which periodic animation plays in the graph view's big view (standalone
 * page + popup modal) — "none", "random" (Graph.svelte picks one animation
 * id at random once per page load), or an id matching a filename under
 * lib/animations/ (see lib/animationRegistry.ts). */
export const ANIMATION_TYPE: string = graphConfig.animationType ?? "none";

/** Seconds between graph-view animation cycles, unless an animation sets
 * its own intervalSeconds. Fixed here, not user-configurable. */
export const ANIMATION_INTERVAL_SECONDS = 5;

/** Which color mode the exported site starts in on first load. A visitor's
 * own toggle still overrides this for the rest of their visit. */
export const DEFAULT_COLOR_MODE: "dark" | "light" =
	themeConfig.defaultColorMode === "light" ? "light" : "dark";

/** Sanitized route paths (folders and/or files) hidden from the file tree. */
export const HIDDEN_PATHS = load<string[]>("hidden.json", []);

/** Route → hex color, from Obsidian's own graph "Groups". Routes with no
 * matching group are absent (the graph falls back to its default color). */
export const NODE_COLORS = load<Record<string, string>>("nodeColors.json", {});

/** CSS classes the Style Settings plugin (if installed) applies to <body> in
 * the source vault — e.g. ITS Theme's "TTRPG" alternate color scheme. */
export const STYLE_SETTINGS_CLASSES = load<string[]>(
	"styleSettingsClasses.json",
	[],
);

/** Sanitized route → original display name (accents and all), for both
 * notes and their ancestor folders. */
export const NAME_MAP = load<Record<string, string>>("nameMap.json", {});

/** Note route → routes of the notes it links to. */
export const LINKS = load<Record<string, string[]>>("links.json", {});
