// import.meta.glob instead of a static `import ... from "$lib/hidden.json"`:
// a static import fails the whole Vite build if hidden.json doesn't exist
// yet (e.g. right after updating the plugin's svelte-lib files but before
// the very first export has run). The glob form simply returns an empty
// result set instead of erroring.
const modules = import.meta.glob("./hidden.json", {
	eager: true,
}) as Record<string, { default?: string[] }>;

/** Sanitized route paths (folders and/or files) hidden from the file tree —
 * see resolveHiddenRoutes() in the plugin's src/main.ts, which is what
 * writes hidden.json at export time. Static/build-time data, so this is a
 * plain constant rather than a store — nothing on the exported site ever
 * changes it. */
export const HIDDEN_PATHS: string[] = Object.values(modules)[0]?.default ?? [];
