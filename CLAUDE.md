# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Obsidian desktop plugin that exports selected vault notes into a static SvelteKit site (styled like Obsidian, deployable to GitHub Pages). User-facing docs: README.md; per-file overview: `file structure.md`.

## Commands

```bash
npm run build      # tsc --noEmit + esbuild production bundle → main.js (what Obsidian loads)
npm run dev        # esbuild watch
npm run lint       # eslint (src/ only — svelte-lib/, tests/ are ignored)
npm test           # vitest run
npx vitest run tests/searchText.test.ts            # one file
npx vitest run tests/searchText.test.ts -t "ranks" # one test by name
```

CI (`.github/workflows/lint.yml`) runs `npm ci`, `npm run build`, `npm run lint` on Node 20/22.

## Two codebases in one repo

- **`src/`** — the plugin. Bundled by esbuild into `main.js`; runs inside Obsidian's renderer with both DOM and Node (`fs`, `child_process`) available. Type-checked by `tsconfig.json` (strict, `noUncheckedIndexedAccess`).
- **`svelte-lib/`** — *template* source, copied verbatim into the exported project's `src/` on every export (`scaffold.ts` → `syncPluginFiles`). It is a Svelte 5 / SvelteKit app and is **not** built, type-checked or linted by this repo. It cannot import from `src/` (separate module graph) — shared constants are duplicated on purpose (e.g. `BASE_PATH_SENTINEL` in `src/constants.ts` ↔ `svelte-lib/lib/basePath.ts`; `slugify` in `src/constants.ts` ↔ `svelte-lib/lib/wikiFetch.ts`; `GraphForces` type in `obsidianGraph.ts` ↔ `graphPhysics.ts`). Anything placed in `svelte-lib/` ends up in the published site.

To check `svelte-lib/` changes, use the exported project's toolchain (destination path is `destinationPath` in `data.json`, e.g. `../aerethios-page` relative to the vault): compile components with its `svelte/compiler`, or run `svelte-kit sync` + `svelte-check` on a scratch copy (its `package.json`/`tsconfig.json`/`vite.config.ts`/`src/app.*`/`src/lib/*.json` + `svelte-lib/` copied into `src/`, `node_modules` junctioned). Don't modify the exported project itself.

## Export pipeline (`src/main.ts` `runExport` → `SiteExporter.run` in `src/exporter.ts`)

`main.ts` only holds the plugin lifecycle (commands, settings, file rename/create bookkeeping); one export is a `SiteExporter` with an `ExportContext` (vault/destination paths, `src/lib`, `src/routes`). Files written besides the pages and state (site data JSON, root page, `app.html`, custom scripts, search index, sitemap) are in `siteFiles.ts`.

1. `ensureSvelteProject` (`scaffold.ts`): first run does `npx sv create` + `npm install`; every run syncs `svelte-lib/`, rebuilds `app.css` from Obsidian's captured CSS + theme + snippets (`obsidianCss.ts`; Style Settings classes in `styleSettings.ts`), patches `vite.config.ts` for adapter-static/GitHub Pages and writes the deploy workflow.
2. `writeSiteData` writes data the app reads at build time: JSON files in the project's `src/lib/` (`graphConfig`, `themeConfig`, `nodeColors`, `hidden`, `nameMap`, `links`, `styleSettingsClasses`), all loaded through one `import.meta.glob` in `svelte-lib/lib/exportData.ts` (glob, not static imports, so a missing file doesn't break the build).
3. `loadExportState` decides which notes to re-render (see caching below), then `exportFiles` renders notes 6 at a time.
4. Each note: `pageexporter.ts` reads front matter from Obsidian's metadata cache, `noteRenderer.ts` renders the body with **Obsidian's own `MarkdownRenderer`** into an off-screen container, waits for the DOM to settle (plugins/embeds fill in async), then post-processes: internal links → site routes (exported notes) or plain text (anything else, including missing notes); non-exported note embeds → plain text; headings get slug ids; images/app:// URLs → files copied into `static/<vault path>`; plugin/MathJax runtime CSS captured. The result is written as one `{@html …}` string into `src/routes/<sanitized path>/+page.svelte` + `+page.ts`. Shared page chrome (e.g. `LinkPreview`) lives in `+layout.svelte`, not in the generated pages.
5. `saveExportState` writes `src/lib/pluginCss/*.css`, copies assets, `static/search.json`, sitemap/robots (only if "Site URL" is set).

`static/` is synced, not wiped: everything goes through a `SyncedFolder` (`syncedFolder.ts`), which copies/writes only changed files and, at the very end of a successful export, `prune()`s whatever wasn't copied/written/kept this time — so anything the site needs in `static/` must go through it. The notes' pages in `src/routes/` (cache-skipped ones are `keep()`ed) and the `svelte-lib/` copy in `src/` (pruned only within the manifest) use the same class.

Rendering only works inside Obsidian — there is no way to run it from Node; only pure helpers are unit-testable.

### URLs and the base path

Routes are `/` + `sanitizeRoutePath(vault path)` (accents stripped, unsafe chars → `_`) and always have a trailing slash on the site. Generated HTML carries the `%%BASE%%` sentinel instead of the real base path (unknown at export time: `/<repo>` on GitHub Pages, `""` locally); `applyBase()` swaps it at render time. `data-wiki-href` attributes stay base-less.

### Caching and state files (in the destination folder)

- `.export-cache.json` — vault path → mtime; unchanged notes are skipped.
- `.export-plugins.json` — per-page plugin ids, assets, `deps` + `depsKey` (`dependencyKey()` in `noteRenderer.ts`: link targets' existence/export status, embed mtimes, unresolved links). A changed key forces a re-render even if the note didn't change. Also stores `pageFormat` = `[PAGE_FORMAT_VERSION, siteInfo]`.
- `.export-search.json` — note text, so cached notes stay searchable.
- `.svelte-lib-files.json` — files copied from `svelte-lib/` last time; files no longer in `svelte-lib/` are deleted from the export.

Rules when changing things:
- Changing what generated pages contain or import → bump `PAGE_FORMAT_VERSION` in `pageexporter.ts` (otherwise cached pages keep the old format).
- Removing/renaming a file from `svelte-lib/` → it's cleaned up via the manifest; for projects exported before the manifest existed, add it to `LEGACY_COPIED_FILES` in `scaffold.ts`.

## Graph view (`svelte-lib/lib/Graph.svelte`)

- Physics in `graphPhysics.ts` is a port of Obsidian's own graph worker (d3-force: center, link, many-body, collide, velocityDecay 0.4, alpha decay to 0.001 in 300 ticks). Forces come from the vault's `graph.json`, converted from slider positions like Obsidian does (`computeGraphForces` in `src/obsidianGraph.ts`). All lengths are scaled by `WORLD_SCALE` (0.2; repulsion by its square) so the layout matches Obsidian's at the size the animations are tuned for — keep this if touching physics or animations.
- The component holds the state, frame loop and markup; drawing is in `graphDraw.ts`, pan/zoom/hit-testing geometry in `graphView.ts`.
- The frame loop sleeps when idle and is woken by `wake()`; it never sleeps while a periodic animation is active in the big view.
- Every file in `svelte-lib/lib/animations/` (except `types.ts`) is an animation: default-export a `GraphAnimation` and `export const label = "…"` (the settings tab reads that line from the file). Put shared helpers outside that folder (e.g. `lib/easing.ts`).

## Plugin integrations

`PLUGIN_INTEGRATIONS` in `pluginIntegrations.ts` lists community plugins whose CSS is shipped with the pages using their blocks (currently Fantasy Statblocks). All enabled plugins render via Obsidian anyway; an integration adds CSS, strips its interactive bits, and can be disabled in settings (its code blocks are then renamed to `text` before rendering). A change of plugin version/settings changes its signature and re-renders affected pages.

## Tests

vitest, in `tests/`. The `obsidian` package has no runtime code, so `vitest.config.ts` aliases it to `tests/obsidianStub.ts`. Tests are therefore excluded from `tsc` and eslint (they're typed against the stub); keep tested modules free of Obsidian runtime calls at import time.

## Conventions

- Files use CRLF line endings — preserve them when editing via scripts.
- Comments explain *why* (often at length); match the surrounding density.
- Settings UI strings must pass `eslint-plugin-obsidianmd`'s sentence-case rule (brands are whitelisted in `eslint.config.mts`).
