import * as fs from "fs";
import * as path from "path";
import { mimeTypeOf } from "./constants";
import { readJsonFile } from "./obsidianUtil";

/**
 * Captures the CSS Obsidian itself is running with, straight from the live
 * document — the plugin runs inside Obsidian's own renderer, so this is the
 * exact stylesheet every theme is written against.
 *
 * A community theme is only a thin layer of overrides on top of Obsidian's
 * built-in app.css: it mostly redefines variables (--color-base-*,
 * --h1-size, …) whose defaults, and every rule that actually *uses* them,
 * live in app.css. Shipping a theme's CSS on its own — without that base —
 * renders as something that looks nothing like the theme in Obsidian.
 */

/** Obsidian's built-in app.css, with every relative `url(...)` inlined as a
 * data URI (the exported site can't reach `app://` resources). Empty string
 * if it can't be found. */
export async function captureObsidianBaseCss(): Promise<string> {
	const sheet = Array.from(document.styleSheets).find(
		(s) => !!s.href && /\/app\.css(\?.*)?$/.test(s.href),
	);
	if (!sheet?.href) {
		console.warn("[SvelteExporter] Obsidian's app.css not found in document");
		return "";
	}

	// Raw text first: cssRules is Chromium's parsed view, which silently
	// drops every rule/property Chromium doesn't support (Firefox/Safari
	// prefixes, …) — fine inside Obsidian, not on a public site.
	let cssText = "";
	try {
		// eslint-disable-next-line no-restricted-globals -- local app:// resource, not a network request (requestUrl can't read those)
		const res = await fetch(sheet.href);
		if (res.ok) cssText = await res.text();
	} catch {
		// fall through to cssRules
	}
	if (!cssText) {
		try {
			cssText = cssRulesText(sheet);
		} catch (e) {
			console.warn("[SvelteExporter] Could not read app.css rules", e);
			return "";
		}
	}

	return inlineRelativeUrls(cssText, sheet.href);
}

/**
 * Appearance settings (accent color, font size, custom fonts, …) — Obsidian
 * applies them as inline custom properties on <body>, which beat any theme
 * rule. Returned as a high-specificity rule meant to be appended last, to
 * reproduce that precedence. Empty string if none.
 */
export function captureBodyAppearanceCss(): string {
	const declarations = Array.from(document.body.style)
		.filter((prop) => prop.startsWith("--"))
		.map(
			(prop) =>
				`  ${prop}: ${document.body.style.getPropertyValue(prop)};`,
		);
	if (!declarations.length) return "";
	return `body.obsidian-app.obsidian-app.obsidian-app {\n${declarations.join("\n")}\n}`;
}

/** Variables the Style Settings plugin injects for its `variable-*` settings
 * (gated behind `body.css-settings-manager`). Empty string if not installed. */
export function captureStyleSettingsCss(): string {
	return document.getElementById("css-settings-manager")?.textContent ?? "";
}

export async function inlineRelativeUrls(css: string, baseHref: string): Promise<string> {
	const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
	const targets = new Set<string>();
	for (const match of css.matchAll(urlPattern)) {
		const ref = match[2]?.trim();
		if (ref && !/^(data:|https?:|#)/i.test(ref)) targets.add(ref);
	}

	const inlined = new Map<string, string>();
	await Promise.all(
		[...targets].map(async (ref) => {
			try {
				// eslint-disable-next-line no-restricted-globals -- local app:// resource, not a network request (requestUrl can't read those)
				const res = await fetch(new URL(ref, baseHref).href);
				if (!res.ok) return;
				const type =
					res.headers.get("content-type") ||
					mimeTypeOf(ref) ||
					"application/octet-stream";
				const data = Buffer.from(await res.arrayBuffer()).toString(
					"base64",
				);
				inlined.set(ref, `data:${type};base64,${data}`);
			} catch {
				// leave this reference as-is
			}
		}),
	);

	return css.replace(urlPattern, (whole, _quote: string, ref: string) => {
		const dataUri = inlined.get(ref.trim());
		return dataUri ? `url("${dataUri}")` : whole;
	});
}

/** A stylesheet's rules as CSS text, as Chromium parsed them. Throws if
 * the sheet's rules can't be read. */
export function cssRulesText(sheet: CSSStyleSheet): string {
	return Array.from(sheet.cssRules)
		.map((r) => r.cssText)
		.join("\n");
}

/** CSS captured from the running Obsidian instance — see the capture*() functions above. */
export interface ObsidianCss {
	/** Obsidian's built-in app.css — the base every theme builds on. */
	base: string;
	/** Appearance settings Obsidian applies inline on <body>. */
	appearance: string;
	/** Style Settings plugin's injected variables. */
	styleSettings: string;
}

/** The active theme and snippets — see readActiveCss(). */
export interface ActiveCss {
	cssTheme: string;
	sheets: { label: string; css: string }[];
}

/**
 * The active theme's CSS files followed by every enabled snippet, in
 * cascade order — read from appearance.json unless the "Site theme" setting
 * overrides the theme. Read once per export and shared by buildAppCss
 * (which needs their CSS text) and computeStyleSettingsClasses (which needs
 * the same files' `@settings` metadata), so the two can never disagree
 * about what's "active".
 */
export function readActiveCss(
	obsidianDir: string,
	selectedTheme: string,
): ActiveCss {
	const appearance = readJsonFile<{
		cssTheme?: string;
		enabledCssSnippets?: string[];
	}>(path.join(obsidianDir, "appearance.json"), {}, "appearance.json");

	// selectedTheme="" → follow Obsidian; "__none__" → no theme; else → use named theme
	const cssTheme =
		selectedTheme === "__none__"
			? ""
			: selectedTheme || (appearance.cssTheme ?? "");
	const enabledSnippets = appearance.enabledCssSnippets ?? [];

	const sheets: { label: string; css: string }[] = [];
	const readCssFiles = (
		dir: string,
		include: (file: string) => boolean,
		label: (file: string) => string,
	) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
			if (!include(entry.name)) continue;
			sheets.push({
				label: label(entry.name),
				css: fs.readFileSync(path.join(dir, entry.name), "utf-8"),
			});
		}
	};

	if (cssTheme) {
		readCssFiles(
			path.join(obsidianDir, "themes", cssTheme),
			() => true,
			(f) => `theme: ${cssTheme}/${f}`,
		);
	}
	// Only enabled snippets if the list is defined, otherwise all
	readCssFiles(
		path.join(obsidianDir, "snippets"),
		(f) =>
			!enabledSnippets.length ||
			enabledSnippets.includes(f.replace(/\.css$/, "")),
		(f) => `snippet: ${f}`,
	);

	return { cssTheme, sheets };
}
