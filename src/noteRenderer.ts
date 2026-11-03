import * as fs from "fs";
import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import * as path from "path";
import {
	BASE_PATH_SENTINEL,
	routeOf,
	slugify,
	staticFilePath,
	staticFileUrl,
} from "./constants";
import { inlineRelativeUrls } from "./obsidianCss";
import { PLUGIN_INTEGRATIONS, PluginIntegration } from "./pluginIntegrations";

/**
 * Renders notes with Obsidian's own Markdown renderer — the same one its
 * reading view uses — into an off-screen container, then turns the result
 * into static HTML for the site: callouts, nested lists, footnotes, math,
 * Mermaid, embeds and community plugins' blocks all come out exactly as in
 * Obsidian, and %%comments%% are left out, as in reading view.
 *
 * Links and embeds are then rewritten for the site: a note that's part of
 * the export becomes a site link (or its embedded content); anything else
 * — a note that isn't exported, or doesn't exist — becomes plain text, so
 * nothing of it is published.
 */

/** Vault files a rendered note depends on — see dependencyKey(). */
export interface NoteDeps {
	/** Notes/files it links to. */
	links: string[];
	/** Notes/files embedded in it, at any depth. */
	embeds: string[];
	/** Link targets that matched no file. */
	unresolved: string[];
}

export interface RenderedNote {
	html: string;
	headings: { id: string; text: string; level: number }[];
	/** Routes of the exported notes it links to or embeds. */
	linkedRoutes: string[];
	/** Absolute paths of local files it references — copied into static/. */
	assets: string[];
	/** Stylesheets under src/lib/pluginCss/ the page must import. */
	cssIds: string[];
	/** Integrations with a code block in the note — active or not, so a
	 * later change to that integration knows which pages to re-export. */
	pluginIds: string[];
	deps: NoteDeps;
	/** The note's visible text, whitespace collapsed — for site search and
	 * the page's default description. */
	text: string;
	/** Site URL (base-path sentinel included) of the note's first image. */
	image: string | null;
}

/** Interactive bits no exported page should keep once it's static. */
const INTERACTIVE_SELECTORS = [
	"script",
	"button",
	".clickable-icon",
	".copy-code-button",
	".edit-block-button",
	".markdown-embed-link",
	".heading-collapse-indicator",
	".collapse-indicator",
	".list-collapse-indicator",
	".callout-fold",
];

const KNOWN_PLUGIN_LANGUAGES = new Map(
	PLUGIN_INTEGRATIONS.flatMap((i) =>
		i.codeBlockLanguages.map((lang) => [lang, i.pluginId] as const),
	),
);

/** Content Obsidian or a plugin is known to fill in after render() returns. */
const ASYNC_CONTENT_SELECTOR = [
	".internal-embed",
	"[class*='block-language-']",
	".mermaid",
	".math",
].join(",");

/** How long the rendered DOM must stay unchanged before it counts as done. */
const SETTLE_QUIET_MS = 300;

/** runtimeCss key for MathJax's own stylesheet (and its fonts). */
const MATHJAX_CSS_ID = "mathjax";

export class NoteRenderer {
	private host: HTMLElement | null = null;
	private mathJaxCaptured = false;
	/** Stylesheet id → style id → CSS text, captured from document.head
	 * while rendering (plugins' runtime styles, MathJax). */
	readonly runtimeCss = new Map<string, Map<string, string>>();

	constructor(
		private readonly app: App,
		private readonly vaultPath: string,
		private readonly active: PluginIntegration[],
		/** Vault paths of every note in this export. */
		private readonly exportedPaths: Set<string>,
	) {}

	async render(file: TFile, body: string): Promise<RenderedNote> {
		const { markdown, languages } = prepareMarkdown(
			body,
			new Set(this.active.flatMap((i) => i.codeBlockLanguages)),
		);
		const el = this.getHost().createDiv();
		const component = new Component();
		component.load();
		try {
			await MarkdownRenderer.render(
				this.app,
				markdown,
				el,
				file.path,
				component,
			);
			// Plugins and embeds fill in asynchronously, after render() returns.
			await waitForDomToSettle(
				el,
				el.querySelector(ASYNC_CONTENT_SELECTOR) ? SETTLE_QUIET_MS : 50,
			);

			const deps: NoteDeps = { links: [], embeds: [], unresolved: [] };
			const linkedRoutes = new Set<string>();
			stripInteractivity(el, this.active);
			this.rewriteEmbeds(el, file, deps, linkedRoutes);
			this.rewriteLinks(el, file, deps, linkedRoutes);
			el.querySelectorAll("a.tag").forEach((a) => replaceTag(a, "span"));
			const headings = labelHeadings(el);
			wrapTables(el);
			const assets = rewriteLocalUrls(el, this.vaultPath);
			const cssIds = await this.captureCss(el);
			const image =
				el
					.querySelector(`img[src^="${BASE_PATH_SENTINEL}"]`)
					?.getAttribute("src") ?? null;
			// innerText (the container is laid out) keeps block boundaries
			// as whitespace, where textContent would glue words together.
			const text = el.innerText.replace(/\s+/g, " ").trim();

			return {
				html: el.innerHTML,
				headings,
				linkedRoutes: [...linkedRoutes],
				assets,
				cssIds,
				pluginIds: [
					...new Set(
						[...languages].flatMap((l) => KNOWN_PLUGIN_LANGUAGES.get(l) ?? []),
					),
				],
				deps: {
					links: [...new Set(deps.links)],
					embeds: [...new Set(deps.embeds)],
					unresolved: [...new Set(deps.unresolved)],
				},
				text,
				image,
			};
		} finally {
			component.unload();
			el.remove();
		}
	}

	dispose(): void {
		this.host?.remove();
		this.host = null;
	}

	/** A detached-but-laid-out container, so plugins measuring their own
	 * size (e.g. Fantasy Statblocks' column splitting) see a realistic,
	 * reading-view-sized width. */
	private getHost(): HTMLElement {
		if (!this.host) {
			this.host = document.body.createDiv({
				cls: "markdown-preview-view markdown-rendered",
			});
			this.host.setCssStyles({
				position: "fixed",
				left: "-10000px",
				top: "0",
				width: "700px",
				pointerEvents: "none",
			});
		}
		return this.host;
	}

	private resolve(linktext: string, sourcePath: string) {
		const { linkpath, fragment } = splitLinktext(linktext);
		const dest = linkpath
			? this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
			: this.app.vault.getAbstractFileByPath(sourcePath);
		return {
			linkpath,
			fragment,
			dest: dest instanceof TFile ? dest : null,
		};
	}

	private isExportedNote(file: TFile | null): file is TFile {
		return !!file && file.extension === "md" && this.exportedPaths.has(file.path);
	}

	/**
	 * Embedded notes stay inline (Obsidian already rendered them) if they're
	 * part of the export — hidden from the file tree or not. Otherwise —
	 * not exported, or no such note — they're reduced to plain text, so
	 * nothing of them is published. Embedded images/media are kept as-is —
	 * their files are copied by rewriteLocalUrls().
	 */
	private rewriteEmbeds(
		el: HTMLElement,
		file: TFile,
		deps: NoteDeps,
		linkedRoutes: Set<string>,
	) {
		for (const embed of Array.from(el.querySelectorAll(".internal-embed"))) {
			if (!embed.isConnected) continue; // inside an embed already removed
			const src = embed.getAttribute("src") ?? "";
			const { linkpath, dest } = this.resolve(src, file.path);
			const label = embed.getAttribute("alt") || linkpath || src;
			if (dest) deps.embeds.push(dest.path);
			else deps.unresolved.push(linkpath);
			if (dest && dest.extension !== "md") continue;
			if (!this.isExportedNote(dest)) {
				embed.replaceWith(document.createTextNode(label));
				continue;
			}
			linkedRoutes.add(routeOf(dest.path));
		}
	}

	/** Internal links → site links for exported notes (hidden from the file
	 * tree or not); plain text when they lead nowhere on the site — a note
	 * that isn't exported, or no such note at all. */
	private rewriteLinks(
		el: HTMLElement,
		file: TFile,
		deps: NoteDeps,
		linkedRoutes: Set<string>,
	) {
		el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			const target = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
			const { linkpath, fragment, dest } = this.resolve(target, file.path);
			if (dest) deps.links.push(dest.path);
			else deps.unresolved.push(linkpath);
			if (!this.isExportedNote(dest)) {
				a.replaceWith(document.createTextNode(a.textContent ?? ""));
				return;
			}
			const route = routeOf(dest.path);
			linkedRoutes.add(route);
			// Nested heading links ("Note#H1#H2") target the last heading.
			const heading = fragment.split("#").pop() ?? "";
			a.setAttribute(
				"href",
				BASE_PATH_SENTINEL + route + (heading ? `#${slugify(heading)}` : ""),
			);
			// Read by LinkPreview.svelte, which adds the real base itself.
			a.setAttribute("data-wiki-href", route);
			a.setAttribute("data-wiki-fragment", encodeURIComponent(heading));
			a.removeAttribute("data-href");
			a.removeAttribute("target");
			a.removeAttribute("rel");
		});
	}

	/** Captures the runtime CSS the rendered note relies on, and returns the
	 * pluginCss/ stylesheets the page must import. */
	private async captureCss(el: HTMLElement): Promise<string[]> {
		const ids: string[] = [];
		for (const integration of this.active) {
			const blocks = integration.codeBlockLanguages.flatMap((lang) =>
				Array.from(el.querySelectorAll<HTMLElement>(`.block-language-${lang}`)),
			);
			if (!blocks.length) continue;
			ids.push(integration.pluginId);
			this.captureRuntimeCss(integration, blocks);
		}
		if (el.querySelector("mjx-container")) {
			ids.push(MATHJAX_CSS_ID);
			await this.captureMathJaxCss();
		}
		return ids;
	}

	private chunksFor(id: string): Map<string, string> {
		let chunks = this.runtimeCss.get(id);
		if (!chunks) {
			chunks = new Map();
			this.runtimeCss.set(id, chunks);
		}
		return chunks;
	}

	private captureRuntimeCss(integration: PluginIntegration, blocks: HTMLElement[]) {
		const chunks = this.chunksFor(integration.pluginId);
		const styleEls = new Set<HTMLStyleElement>();
		for (const selector of integration.runtimeStyleSelectors) {
			document.head
				.querySelectorAll<HTMLStyleElement>(selector)
				.forEach((s) => styleEls.add(s));
		}
		// Svelte 3/4 components without external CSS inject their scoped
		// styles as <style id="svelte-HASH">, matching the class they put
		// on every element they render.
		for (const block of blocks) {
			for (const hash of new Set(block.innerHTML.match(/svelte-[a-z0-9]+/g))) {
				const s = document.getElementById(hash);
				if (s instanceof HTMLStyleElement) styleEls.add(s);
			}
		}
		for (const s of styleEls) {
			const css = readStyleElement(s);
			if (css) chunks.set(s.id || css, css);
		}
	}

	/** MathJax's CHTML output only looks right with its stylesheet, which
	 * loads its fonts from Obsidian's app:// resources — inlined here. */
	private async captureMathJaxCss() {
		if (this.mathJaxCaptured) return;
		const style = document.getElementById("MJX-CHTML-styles");
		if (!(style instanceof HTMLStyleElement)) return;
		this.mathJaxCaptured = true;
		const css = await inlineRelativeUrls(readStyleElement(style), document.baseURI);
		this.chunksFor(MATHJAX_CSS_ID).set(style.id, css);
	}
}

/**
 * Lists the note's fenced code block languages, and renames those of
 * integrations turned off in settings (not in `activeLanguages`) so their
 * plugin doesn't render them — they're exported as plain code instead.
 */
export function prepareMarkdown(body: string, activeLanguages: Set<string>) {
	const languages = new Set<string>();
	let fence: string | null = null;
	const lines = body.split("\n").map((line) => {
		const open = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)(.*)$/);
		if (!open) return line;
		const [, indent = "", marks = "", lang = "", rest = ""] = open;
		if (fence) {
			if (marks.startsWith(fence) && !lang) fence = null;
			return line;
		}
		fence = marks;
		if (!lang) return line;
		languages.add(lang);
		const turnedOff =
			KNOWN_PLUGIN_LANGUAGES.has(lang) && !activeLanguages.has(lang);
		return turnedOff ? `${indent}${marks}text${rest}` : line;
	});
	return { markdown: lines.join("\n"), languages };
}

/**
 * A fingerprint of everything outside a note that its exported page
 * depends on: whether its link targets still exist and are exported,
 * the embedded files' modification times, and what its unresolved links
 * would resolve to now. A cached page whose fingerprint changed must be
 * rendered again even though the note itself didn't change.
 */
export function dependencyKey(
	app: App,
	sourcePath: string,
	deps: NoteDeps,
	exportedPaths: Set<string>,
): string {
	const fileAt = (p: string) => {
		const f = app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	};
	const exported = (p: string) => (exportedPaths.has(p) ? "e" : "-");
	return [
		...deps.links.map((p) => `L ${p} ${fileAt(p) ? "1" : "0"} ${exported(p)}`),
		...deps.embeds.map(
			(p) => `E ${p} ${fileAt(p)?.stat.mtime ?? "gone"} ${exported(p)}`,
		),
		...deps.unresolved.map(
			(lp) =>
				`U ${lp} ${app.metadataCache.getFirstLinkpathDest(lp, sourcePath)?.path ?? ""}`,
		),
	]
		.sort()
		.join("\n");
}

// ── DOM helpers ────────────────────────────────────────────────────────────

/** Splits "Note#Heading" into its note part and fragment. */
function splitLinktext(target: string): { linkpath: string; fragment: string } {
	const hashIdx = target.indexOf("#");
	if (hashIdx === -1) return { linkpath: target.trim(), fragment: "" };
	return {
		linkpath: target.slice(0, hashIdx).trim(),
		fragment: target.slice(hashIdx + 1).trim(),
	};
}

/** Swaps `el` for a `tag` element with the same classes and content. */
function replaceTag(el: Element, tag: string) {
	const replacement = document.createElement(tag);
	replacement.className = el.className;
	replacement.append(...Array.from(el.childNodes));
	el.replaceWith(replacement);
}

/**
 * Gives every heading of the note itself (not those inside embeds or
 * plugin blocks) the id the site's links and table of contents use.
 * Repeated headings get "-1", "-2"… suffixes so each table of contents
 * entry reaches its own heading; the first keeps the bare slug, which is
 * where a [[Note#Heading]] link leads, as in Obsidian.
 */
function labelHeadings(el: HTMLElement) {
	const headings: RenderedNote["headings"] = [];
	const used = new Set<string>();
	const selector = ":is(h1, h2, h3, h4, h5, h6)";
	el.querySelectorAll<HTMLElement>(
		`:scope > ${selector}, :scope > div > ${selector}`,
	).forEach((h) => {
		const text = (h.getAttribute("data-heading") ?? h.textContent ?? "").trim();
		const slug = slugify(text) || "heading";
		let id = slug;
		for (let i = 1; used.has(id); i++) id = `${slug}-${i}`;
		used.add(id);
		h.id = id;
		headings.push({ id, text, level: Number(h.tagName[1]) });
	});
	return headings;
}

/**
 * Wraps every table in a scroll container (see .table-scroll in
 * markdown.css) — a bare `<table>` with overflow:auto on itself only scrolls
 * once content can no longer shrink to fit, which for normally wrappable
 * text never happens; the wrapper + nowrap cells combo is what makes the
 * table keep its natural column widths and scroll on a narrow screen.
 */
function wrapTables(el: HTMLElement) {
	el.querySelectorAll("table").forEach((table) => {
		if (table.parentElement?.classList.contains("table-scroll")) return;
		const wrapper = document.createElement("div");
		wrapper.className = "table-scroll";
		table.replaceWith(wrapper);
		wrapper.appendChild(table);
	});
}

function stripInteractivity(el: HTMLElement, active: PluginIntegration[]) {
	el.querySelectorAll(INTERACTIVE_SELECTORS.join(",")).forEach((n) =>
		n.remove(),
	);
	// Each integration's own interactive bits, only inside its own blocks.
	for (const integration of active) {
		if (!integration.removeSelectors.length) continue;
		for (const lang of integration.codeBlockLanguages) {
			el.querySelectorAll(`.block-language-${lang}`).forEach((block) =>
				block
					.querySelectorAll(integration.removeSelectors.join(","))
					.forEach((n) => n.remove()),
			);
		}
	}
	// Foldable callouts can't be unfolded on the static site — show them open.
	el.querySelectorAll(".callout.is-collapsed").forEach((c) => {
		c.classList.remove("is-collapsed");
		c.querySelectorAll<HTMLElement>(".callout-content").forEach((content) =>
			content.style.removeProperty("display"),
		);
	});
	el.querySelectorAll("*").forEach((n) => {
		for (const attr of Array.from(n.attributes)) {
			if (
				attr.name.startsWith("on") ||
				attr.name === "contenteditable" ||
				attr.name === "draggable" ||
				attr.name === "tabindex"
			) {
				n.removeAttribute(attr.name);
			}
		}
	});
	el.querySelectorAll("input, select, textarea").forEach((n) =>
		n.setAttribute("disabled", ""),
	);
}

/**
 * Resolves once `el` has gone `initialQuietMs` without changing — or, as
 * soon as it changes at all, SETTLE_QUIET_MS. Most notes have nothing
 * asynchronous in them and get the short initial wait (with 6 notes
 * rendered at once, a fixed 300ms was most of a big export's time); one
 * that turns out to have some still waits as long as it must.
 */
function waitForDomToSettle(
	el: HTMLElement,
	initialQuietMs: number,
	maxMs = 5000,
): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			observer.disconnect();
			window.clearTimeout(quietTimer);
			window.clearTimeout(hardStop);
			resolve();
		};
		let quietTimer = window.setTimeout(done, initialQuietMs);
		const hardStop = window.setTimeout(done, maxMs);
		const observer = new MutationObserver(() => {
			window.clearTimeout(quietTimer);
			quietTimer = window.setTimeout(done, SETTLE_QUIET_MS);
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
	});
}

/**
 * Where a local file referenced by a rendered note is served on the site
 * (relative to static/): its vault path, or _external/<name> for a file
 * outside the vault.
 */
export function assetStaticPath(absolutePath: string, vaultPath: string): string {
	const rel = path.relative(vaultPath, absolutePath);
	return rel.startsWith("..") || path.isAbsolute(rel)
		? `_external/${path.basename(absolutePath)}`
		: staticFilePath(rel);
}

/**
 * Obsidian serves local files as app://<id>/<absolute path>?<mtime> — those
 * are rewritten to where the file is served on the site (see
 * assetStaticPath) and returned so the caller copies them there.
 */
function rewriteLocalUrls(el: HTMLElement, vaultPath: string): string[] {
	const assets = new Set<string>();
	const toSiteUrl = (url: string): string | null => {
		const filePath = appUrlToPath(url);
		if (!filePath || !fs.existsSync(filePath)) return null;
		assets.add(filePath);
		return staticFileUrl(assetStaticPath(filePath, vaultPath));
	};

	el.querySelectorAll<HTMLElement>("[src]").forEach((n) => {
		const url = toSiteUrl(n.getAttribute("src") ?? "");
		if (url) n.setAttribute("src", url);
	});
	el.querySelectorAll<HTMLElement>("[style*='app://']").forEach((n) => {
		const style = n.getAttribute("style") ?? "";
		n.setAttribute(
			"style",
			style.replace(
				/url\(\s*(['"]?)(app:\/\/[^'")]+)\1\s*\)/g,
				(whole, _q: string, url: string) => {
					const siteUrl = toSiteUrl(url);
					return siteUrl ? `url("${siteUrl}")` : whole;
				},
			),
		);
	});
	return [...assets];
}

function appUrlToPath(url: string): string | null {
	if (!url.startsWith("app://")) return null;
	try {
		let pathname = decodeURIComponent(new URL(url).pathname);
		// Windows: "/C:/Users/…" → "C:/Users/…"
		if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
		return path.normalize(pathname);
	} catch {
		return null;
	}
}

function readStyleElement(s: HTMLStyleElement): string {
	// Rules added through insertRule() never show up in textContent.
	try {
		const rules = s.sheet?.cssRules;
		if (rules?.length) {
			return Array.from(rules)
				.map((r) => r.cssText)
				.join("\n");
		}
	} catch {
		// fall through
	}
	return s.textContent ?? "";
}
