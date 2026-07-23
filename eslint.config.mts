import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// This plugin's own code (as opposed to the svelte-lib/
				// templates it ships) runs in Obsidian's desktop Node-integrated
				// renderer and uses fs/path/child_process/Buffer/require directly.
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		plugins: { obsidianmd },
		rules: {
			// Extend the default brand list with this plugin's own product
			// names so they keep their canonical casing under sentence-case
			// (e.g. "SvelteKit", not "Sveltekit").
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					enforceCamelCaseLower: true,
					brands: [
						...DEFAULT_BRANDS,
						"Svelte",
						"SvelteKit",
						"GitHub Pages",
						"Svelte Exporter",
					],
				},
			],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		// Template source copied verbatim into each exported SvelteKit
		// project (see scaffold.ts) — not part of this plugin's own
		// tsconfig/build, and lints as its own SvelteKit project once
		// scaffolded.
		"svelte-lib",
	]),
);
