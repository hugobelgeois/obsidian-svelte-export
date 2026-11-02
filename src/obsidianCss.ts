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
			cssText = Array.from(sheet.cssRules)
				.map((r) => r.cssText)
				.join("\n");
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

async function inlineRelativeUrls(css: string, baseHref: string): Promise<string> {
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
					res.headers.get("content-type") || guessMimeType(ref);
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

function guessMimeType(ref: string): string {
	const ext = ref.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "woff2":
			return "font/woff2";
		case "woff":
			return "font/woff";
		case "ttf":
			return "font/ttf";
		case "otf":
			return "font/otf";
		case "svg":
			return "image/svg+xml";
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}
