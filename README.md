# Webpage Svelte Export

An Obsidian plugin that turns selected notes of a vault into a static
website (SvelteKit), styled like Obsidian and ready to deploy on GitHub
Pages. Desktop only.

## What the site gets

- Every selected note as a page, rendered by Obsidian itself: callouts,
  nested lists, footnotes, math, Mermaid, embeds and community plugins'
  blocks look as they do in Obsidian. `%%comments%%` are left out.
- Your Obsidian theme, CSS snippets, appearance settings and Style
  Settings choices.
- A file tree (folders and notes can be hidden from it while still being
  exported), full-text search, a table of contents, and link previews on
  hover.
- A graph view (sidebar preview, popup, or the site's home page) using
  Obsidian's own graph physics, forces and color groups.
- Links and embeds pointing to notes that aren't exported (or don't
  exist) are shown as plain text — nothing outside the export is
  published.
- Sharing metadata (OpenGraph), a sitemap, and the page language.

## Usage

1. In the plugin settings, set the **destination path** (absolute, or
   relative to the vault) and tick the files and folders to export.
2. Run **Export selected files to Svelte pages** (command palette or the
   globe ribbon icon). The first export creates the SvelteKit project
   (`npx sv create` + `npm install`) — Node.js must be installed.
3. In the destination folder, `npm run dev` previews the site,
   `npm run build` builds it into `build/`.

Unchanged notes are skipped on later exports; **Clear cache** in the
settings forces a full re-export.

### Deploying to GitHub Pages

Push the destination folder to a GitHub repository, then in the repo's
Settings → Pages, set the source to **GitHub Actions**. The workflow the
plugin writes (`.github/workflows/deploy.yml`) builds and publishes the
site on every push. Set **Site URL** in the plugin settings to the
published address to get link preview images and a sitemap.

### Front matter options

| Property | Effect |
| --- | --- |
| `title` | Page title (defaults to the file name) |
| `description` | Description under the title, and in search engines and link previews |
| `full-width: true` | The page uses the whole width instead of the reading column |
| `full-height: true` | The page fills the window's height |
| `hide-title: true` | Hides the title at the top of the page |

## Development

```bash
npm install
npm run dev     # rebuild main.js on change
npm run build   # type-check + production build
npm run lint
npm test        # vitest
```

See [file structure.md](file%20structure.md) for what each file does.
