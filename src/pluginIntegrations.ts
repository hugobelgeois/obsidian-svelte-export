import * as fs from "fs";
import { App, Component, MarkdownRenderer } from "obsidian";
import * as path from "path";
import { BASE_PATH_SENTINEL } from "./constants";

/**
 * Other community plugins whose rendered output can be baked into the
 * exported site. Each one is rendered by the real plugin, inside Obsidian,
 * at export time (see PluginBlockRenderer) — the site only ever gets the
 * resulting static HTML + the plugin's CSS, never its interactive behavior.
 *
 * Adding support for another plugin that renders through a fenced code
 * block is usually just one more entry here.
 */
export interface PluginIntegration {
	pluginId: string;
	/** Shown in settings if the plugin's own manifest can't be read. */
	name: string;
	/** Fenced code block languages the plugin registers a processor for. */
	codeBlockLanguages: string[];
	/** Interactive bits to drop from the rendered output, on top of
	 * GENERIC_INTERACTIVE_SELECTORS. */
	removeSelectors: string[];
	/** <style> elements the plugin injects into document.head at runtime
	 * (rather than shipping in its styles.css) that its output relies on. */
	runtimeStyleSelectors: string[];
}

export const PLUGIN_INTEGRATIONS: PluginIntegration[] = [
	{
		pluginId: "obsidian-5e-statblocks",
		name: "Fantasy Statblocks",
		codeBlockLanguages: ["statblock"],
		// .icons = the hover "…" menu (export as PNG/JSON, edit, …).
		removeSelectors: [".icons", ".statblock-loading"],
		// A layout's custom colors/fonts, injected via insertRule().
		runtimeStyleSelectors: ['style[id^="FS_CSS_PROPERTIES_"]'],
	},
];

/** Interactive elements no plugin output should keep once it's static. */
const GENERIC_INTERACTIVE_SELECTORS = [
	"script",
	"button",
	".clickable-icon",
	".copy-code-button",
	".edit-block-button",
];

interface PluginsInternal {
	manifests: Record<string, { name: string; dir?: string } | undefined>;
	enabledPlugins: Set<string>;
}

/** Obsidian's plugin manager — not part of the public API typings. */
function pluginsOf(app: App): PluginsInternal {
	return (app as unknown as { plugins: PluginsInternal }).plugins;
}

export function isPluginInstalled(app: App, pluginId: string): boolean {
	return !!pluginsOf(app).manifests[pluginId];
}

export function isPluginEnabled(app: App, pluginId: string): boolean {
	return pluginsOf(app).enabledPlugins.has(pluginId);
}

export function pluginDisplayName(app: App, integration: PluginIntegration) {
	return pluginsOf(app).manifests[integration.pluginId]?.name ?? integration.name;
}

/** Integrations both enabled in Obsidian and not turned off in settings. */
export function activeIntegrations(
	app: App,
	disabledIntegrations: string[],
): PluginIntegration[] {
	return PLUGIN_INTEGRATIONS.filter(
		(i) =>
			isPluginEnabled(app, i.pluginId) &&
			!disabledIntegrations.includes(i.pluginId),
	);
}

/**
 * Fingerprint of everything that changes an integration's rendered output
 * (whether it's active, the plugin's version, its settings/layouts) — a
 * page rendered against a different fingerprint must be re-exported even if
 * the note itself hasn't changed.
 */
export function integrationSignature(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
	active: boolean,
): string {
	if (!active) return "off";
	const dir = pluginDir(app, vaultPath, integration);
	const mtimes = ["manifest.json", "data.json", "styles.css"].map((f) => {
		try {
			return fs.statSync(path.join(dir, f)).mtimeMs;
		} catch {
			return 0;
		}
	});
	return mtimes.join(":");
}

function pluginDir(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
): string {
	const dir =
		pluginsOf(app).manifests[integration.pluginId]?.dir ??
		`${app.vault.configDir}/plugins/${integration.pluginId}`;
	return path.join(vaultPath, dir);
}

export interface RenderedBlock {
	html: string;
	/** Absolute paths of local files the HTML references — to be copied
	 * flat into static/ under their basename (see rewriteLocalUrls). */
	assets: string[];
}

export type LinkResolver = (target: string) => string | null;

/**
 * Renders plugin code blocks through Obsidian itself into an off-screen
 * container, then snapshots the resulting DOM as static HTML.
 */
export class PluginBlockRenderer {
	private readonly byLanguage = new Map<string, PluginIntegration>();
	private host: HTMLElement | null = null;
	/** pluginId → style id → CSS text, captured from document.head. */
	readonly runtimeCss = new Map<string, Map<string, string>>();

	constructor(
		private readonly app: App,
		readonly active: PluginIntegration[],
	) {
		for (const integration of active) {
			for (const lang of integration.codeBlockLanguages) {
				this.byLanguage.set(lang, integration);
			}
		}
	}

	integrationFor(lang: string): PluginIntegration | undefined {
		return this.byLanguage.get(lang);
	}

	async render(
		integration: PluginIntegration,
		lang: string,
		source: string,
		sourcePath: string,
		resolveLink: LinkResolver,
	): Promise<RenderedBlock> {
		const el = this.getHost().createDiv();
		const component = new Component();
		component.load();
		try {
			const fence = "`".repeat(Math.max(3, longestBacktickRun(source) + 1));
			await MarkdownRenderer.render(
				this.app,
				`${fence}${lang}\n${source}\n${fence}`,
				el,
				sourcePath,
				component,
			);
			// Most plugins mount their UI asynchronously after the
			// processor returns (Svelte components, images, data lookups).
			await waitForDomToSettle(el);

			stripInteractivity(el, integration);
			rewriteInternalLinks(el, resolveLink);
			const assets = rewriteLocalUrls(el);
			this.captureRuntimeCss(el, integration);
			return { html: el.innerHTML, assets };
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

	private captureRuntimeCss(el: HTMLElement, integration: PluginIntegration) {
		let chunks = this.runtimeCss.get(integration.pluginId);
		if (!chunks) {
			chunks = new Map();
			this.runtimeCss.set(integration.pluginId, chunks);
		}
		const styleEls = new Set<HTMLStyleElement>();
		for (const selector of integration.runtimeStyleSelectors) {
			document.head
				.querySelectorAll<HTMLStyleElement>(selector)
				.forEach((s) => styleEls.add(s));
		}
		// Svelte 3/4 components without external CSS inject their scoped
		// styles as <style id="svelte-HASH">, matching the class they put
		// on every element they render.
		for (const hash of new Set(el.innerHTML.match(/svelte-[a-z0-9]+/g))) {
			const s = document.getElementById(hash);
			if (s instanceof HTMLStyleElement) styleEls.add(s);
		}
		for (const s of styleEls) {
			const css = readStyleElement(s);
			if (css) chunks.set(s.id || css, css);
		}
	}
}

function longestBacktickRun(text: string): number {
	return Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
}

function waitForDomToSettle(
	el: HTMLElement,
	quietMs = 300,
	maxMs = 5000,
): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			observer.disconnect();
			window.clearTimeout(quietTimer);
			window.clearTimeout(hardStop);
			resolve();
		};
		let quietTimer = window.setTimeout(done, quietMs);
		const hardStop = window.setTimeout(done, maxMs);
		const observer = new MutationObserver(() => {
			window.clearTimeout(quietTimer);
			quietTimer = window.setTimeout(done, quietMs);
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
	});
}

function stripInteractivity(el: HTMLElement, integration: PluginIntegration) {
	const selectors = [
		...GENERIC_INTERACTIVE_SELECTORS,
		...integration.removeSelectors,
	].join(",");
	el.querySelectorAll(selectors).forEach((n) => n.remove());
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

/** Obsidian internal links (data-href="Note#Heading") → site routes, same
 * shape processWikilinks in pageexporter.ts emits. */
function rewriteInternalLinks(el: HTMLElement, resolveLink: LinkResolver) {
	el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
		const target = a.getAttribute("data-href") ?? a.getAttribute("href");
		const href = target ? resolveLink(target) : null;
		if (!href) {
			const span = document.createElement("span");
			span.className = "wiki-unresolved";
			span.textContent = a.textContent;
			a.replaceWith(span);
			return;
		}
		a.setAttribute("href", href);
		a.removeAttribute("target");
		a.removeAttribute("rel");
		a.removeAttribute("data-href");
	});
}

/**
 * Obsidian serves local files as app://<id>/<absolute path>?<mtime> — those
 * are rewritten to the site's static root (by basename, like every other
 * exported image) and returned so the caller copies them there.
 */
function rewriteLocalUrls(el: HTMLElement): string[] {
	const assets = new Set<string>();
	const toSiteUrl = (url: string): string | null => {
		const filePath = appUrlToPath(url);
		if (!filePath || !fs.existsSync(filePath)) return null;
		assets.add(filePath);
		return `${BASE_PATH_SENTINEL}/${encodeURIComponent(path.basename(filePath))}`;
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

/** The plugin's own styles.css (if any), followed by the runtime CSS
 * captured while rendering. */
export function buildIntegrationCss(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
	runtimeChunks: Iterable<string>,
): string {
	const parts: string[] = [];
	const stylesPath = path.join(
		pluginDir(app, vaultPath, integration),
		"styles.css",
	);
	if (fs.existsSync(stylesPath)) {
		parts.push(fs.readFileSync(stylesPath, "utf-8"));
	}
	for (const chunk of runtimeChunks) parts.push(chunk);
	return parts.join("\n\n");
}
