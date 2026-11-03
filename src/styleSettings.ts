import * as fs from "fs";
import * as path from "path";
import type { ActiveCss } from "./obsidianCss";

// ── Style Settings support ──────────────────────────────────────────────────
//
// The community "Style Settings" plugin lets a theme/snippet declare an
// `/* @settings ... */` YAML block describing class-toggle / class-select
// options (e.g. ITS Theme's "TTRPG" alternate color scheme). Style Settings
// then adds/removes the corresponding classes on <body> at runtime, based on
// choices stored in its own data.json — those classes are what the theme's
// CSS actually gates its alternate look behind, so without them an exported
// site only ever gets the theme's default appearance, never the chosen
// variant (e.g. ITS Theme's parchment-style "WOTC/Beyond" scheme).
//
// This only handles `class-toggle` and `class-select` — the two setting
// types that work by toggling a CSS class — not `variable-*` types (which
// Style Settings applies via injected CSS custom properties instead).

interface StyleSettingsItem {
	id?: string;
	type?: string;
	default?: string;
}

interface StyleSettingsSheet {
	sheetId: string;
	items: StyleSettingsItem[];
}

/**
 * Parses one `/* @settings ... *\/` YAML-ish block (Style Settings' format)
 * out of a CSS file's text. Deliberately not a full YAML parser: it only
 * extracts the sheet's top-level `id`, and each entry directly under
 * `settings:` gets its own `id`/`type`/`default` — everything nested deeper
 * (e.g. a class-select's `options:` list) is skipped, since applying a
 * class only needs the chosen/default value, never the option labels.
 */
function parseStyleSettingsSheet(cssText: string): StyleSettingsSheet | null {
	const blockMatch = cssText.match(/\/\*\s*@settings([\s\S]*?)\*\//);
	const blockText = blockMatch?.[1];
	if (!blockText) return null;
	const lines = blockText.split("\n");

	const settingsLineIdx = lines.findIndex((l) => /^\s*settings:\s*$/.test(l));
	if (settingsLineIdx < 0) return null;

	const headerText = lines.slice(0, settingsLineIdx).join("\n");
	const sheetId = headerText.match(/^\s*id:\s*(\S+)/m)?.[1];
	if (!sheetId) return null;

	const itemLines = lines.slice(settingsLineIdx + 1);

	// Every top-level setting is a "-" bullet at the same indentation — the
	// first bullet we see establishes that indentation.
	let baseIndent: number | null = null;
	for (const l of itemLines) {
		const indent = l.match(/^(\s*)-/)?.[1]?.length;
		if (indent !== undefined) {
			baseIndent = indent;
			break;
		}
	}
	if (baseIndent === null) return { sheetId, items: [] };

	const items: StyleSettingsItem[] = [];
	let current: Record<string, string> | null = null;
	// Once set, lines more indented than this are part of a nested list
	// (e.g. a class-select's `options:`) and get skipped entirely.
	let skipUntilIndentLE: number | null = null;

	for (const raw of itemLines) {
		if (!raw.trim()) continue;
		const indent = raw.match(/^(\s*)/)?.[1]?.length ?? 0;

		if (skipUntilIndentLE !== null) {
			if (indent > skipUntilIndentLE) continue;
			skipUntilIndentLE = null;
		}

		const bulletMatch = raw.match(/^(\s*)-\s*(.*)$/);
		if (bulletMatch && indent === baseIndent) {
			if (current) items.push(current);
			current = {};
			const inline = bulletMatch[2];
			const inlineKv = inline?.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
			const inlineKey = inlineKv?.[1];
			if (inlineKey !== undefined) current[inlineKey] = (inlineKv?.[2] ?? "").trim();
			continue;
		}

		if (!current || indent <= baseIndent) continue;

		const kvMatch = raw.match(/^(\s*)([a-zA-Z_][\w-]*):\s*(.*)$/);
		const key = kvMatch?.[2];
		if (key === undefined) continue;
		current[key] = (kvMatch?.[3] ?? "").trim();
		if (key === "options") skipUntilIndentLE = indent;
	}
	if (current) items.push(current);

	return { sheetId, items };
}

/**
 * Computes the list of CSS classes the Style Settings plugin would currently
 * have applied to <body> — from the active theme's CSS plus every enabled
 * snippet, combined with the user's actual choices in the Style Settings
 * plugin's own data.json (falling back to each setting's declared default
 * when the user never touched it). Returns [] if Style Settings isn't
 * installed, or nothing resolves.
 */
export function computeStyleSettingsClasses(
	obsidianDir: string,
	activeCss: ActiveCss,
): string[] {
	const dataPath = path.join(
		obsidianDir,
		"plugins",
		"obsidian-style-settings",
		"data.json",
	);
	if (!fs.existsSync(dataPath)) return [];

	let savedValues: Record<string, unknown>;
	try {
		savedValues = JSON.parse(
			fs.readFileSync(dataPath, "utf-8"),
		) as Record<string, unknown>;
	} catch {
		console.warn(
			"[SvelteExporter] Could not parse Style Settings' data.json",
		);
		return [];
	}

	const classes = new Set<string>();
	for (const { css } of activeCss.sheets) {
		const sheet = parseStyleSettingsSheet(css);
		if (!sheet) continue;
		for (const item of sheet.items) {
			if (!item.id || !item.type) continue;
			const key = `${sheet.sheetId}@@${item.id}`;
			const raw = Object.prototype.hasOwnProperty.call(savedValues, key)
				? savedValues[key]
				: item.default;

			if (item.type === "class-toggle") {
				if (raw === true || raw === "true") classes.add(item.id);
			} else if (item.type === "class-select") {
				const value = typeof raw === "string" ? raw.trim() : "";
				if (value && value !== "none") classes.add(value);
			}
		}
	}

	return [...classes];
}
