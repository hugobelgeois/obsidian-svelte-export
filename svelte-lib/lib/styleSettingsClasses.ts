// import.meta.glob instead of a static `import ... from "$lib/styleSettingsClasses.json"`:
// a static import fails the whole Vite build if the file doesn't exist yet
// (e.g. right after updating the plugin's svelte-lib files but before the
// very first export has run). The glob form simply returns an empty result
// set instead of erroring.
const modules = import.meta.glob("./styleSettingsClasses.json", {
	eager: true,
}) as Record<string, { default?: string[] }>;

/** CSS classes the Style Settings plugin (if installed) currently applies
 * to <body> in the source vault — e.g. ITS Theme's "TTRPG" alternate color
 * scheme. Applied to <body> in +layout.svelte so theme CSS gated behind
 * these classes renders the same way it does in Obsidian. See
 * computeStyleSettingsClasses() in the plugin's src/scaffold.ts. */
export const STYLE_SETTINGS_CLASSES: string[] =
	Object.values(modules)[0]?.default ?? [];
