import * as fs from "fs";
import { App, parseYaml, TFile } from "obsidian";
import * as path from "path";
import {
	type LayoutBlock,
	LIVE_STATBLOCK_ATTR,
	type LiveStatblock,
	markLinks,
	statblockSources,
	yamlChunks,
} from "../svelte-lib/lib/statblockSource";
import { pageRouteOf } from "./constants";
import { splitLinktext } from "./noteRenderer";

/**
 * Statblocks whose layout has JavaScript blocks can be interactive: in
 * Obsidian that code reads the vault, and edits the note to have the
 * statblock rendered again. Their rendered HTML alone can't do that, so it
 * also carries (as an attribute) what svelte-lib/lib/liveStatblocks.ts
 * needs to run that code in the visitor's browser: the layout and the
 * statblocks' sources — never anything else of a note.
 */

export const STATBLOCKS_PLUGIN_ID = "obsidian-5e-statblocks";

/** Layout blocks the site can render again — a layout with any other one
 * (e.g. "spells") stays static. "action" blocks are buttons, not exported. */
const SUPPORTED_BLOCKS = new Set([
	"action",
	"collapse",
	"group",
	"heading",
	"ifelse",
	"image",
	"inline",
	"javascript",
	"property",
	"subheading",
	"table",
	"text",
	"traits",
]);

interface Layout {
	id: string;
	name: string;
	blocks: LayoutBlock[];
}

export interface StatblockLayouts {
	layouts: Layout[];
	defaultId?: string;
}

/** The vault's own Fantasy Statblocks layouts, read from its settings. */
export function readLayouts(pluginDir: string): StatblockLayouts {
	try {
		const data = JSON.parse(
			fs.readFileSync(path.join(pluginDir, "data.json"), "utf-8"),
		) as { layouts?: Layout[]; default?: string };
		return { layouts: data.layouts ?? [], defaultId: data.default };
	} catch {
		return { layouts: [] };
	}
}

/** Replaces "layout" blocks by the blocks of the layout they refer to;
 * null if anything in there can't be rendered by the site. */
function resolveBlocks(
	blocks: LayoutBlock[],
	layouts: Layout[],
	depth = 0,
): LayoutBlock[] | null {
	// Layouts including each other.
	if (depth > 20) return null;
	const resolved: LayoutBlock[] = [];
	for (const block of blocks) {
		if (block.type === "layout") {
			const layout = layouts.find((l) => l.id === block.layout);
			const nested = layout && resolveBlocks(layout.blocks, layouts, depth + 1);
			if (!nested) return null;
			resolved.push({ type: "group", properties: [], nested });
			continue;
		}
		if (!SUPPORTED_BLOCKS.has(block.type)) return null;
		const copy = { ...block };
		if (block.nested) {
			const nested = resolveBlocks(block.nested, layouts, depth + 1);
			if (!nested) return null;
			copy.nested = nested;
		}
		if (block.conditions) {
			copy.conditions = [];
			for (const c of block.conditions) {
				const nested = resolveBlocks(c.nested, layouts, depth + 1);
				if (!nested) return null;
				copy.conditions.push({ ...c, nested });
			}
		}
		resolved.push(copy);
	}
	return resolved;
}

function hasJavascript(blocks: LayoutBlock[]): boolean {
	return blocks.some(
		(b) =>
			b.type === "javascript" ||
			hasJavascript(b.nested ?? []) ||
			(b.conditions ?? []).some((c) => hasJavascript(c.nested)),
	);
}

function tryParse(yaml: string): unknown {
	try {
		return parseYaml(yaml) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Marks the live statblocks among `els`, the statblocks of the note itself
 * (not those of notes it embeds) in document order; `body` is the markdown
 * they were rendered from. Returns what the page then depends on besides
 * its own note: the notes linked to, and the links matching none.
 * `isPublished` tells whether all of a note is published.
 */
export async function markLiveStatblocks(
	app: App,
	file: TFile,
	body: string,
	els: HTMLElement[],
	{ layouts, defaultId }: StatblockLayouts,
	isPublished: (file: TFile) => boolean,
): Promise<{ notes: string[]; unresolved: string[] }> {
	const notes = new Set<string>();
	const unresolved = new Set<string>();
	const sources = statblockSources(body);
	// Some aren't plain top-level code blocks (e.g. in a callout): which
	// source is whose can't be told.
	if (sources.length !== els.length) return { notes: [], unresolved: [] };

	for (const [index, el] of els.entries()) {
		const source = sources[index] ?? "";
		const params = tryParse(markLinks(source));
		if (!params || typeof params !== "object") continue;
		// Based on a bestiary creature, which isn't exported.
		if (["monster", "creature", "extends"].some((k) => k in params)) continue;
		const name = (params as { layout?: unknown }).layout;
		const layout = layouts.find((l) =>
			name === undefined ? l.id === defaultId : l.name === name,
		);
		const blocks = layout && resolveBlocks(layout.blocks, layouts);
		if (!blocks || !hasJavascript(blocks)) continue;

		const live: LiveStatblock = {
			path: file.path,
			index,
			layout: blocks,
			files: {
				[file.path]: { route: pageRouteOf(file.path), sources },
			},
			links: {},
			yaml: {},
		};
		for (const [, target = ""] of source.matchAll(/\[\[([^\]|]+)/g)) {
			const { linkpath } = splitLinktext(target);
			if (!linkpath) continue;
			const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (!dest) {
				unresolved.add(linkpath);
				continue;
			}
			notes.add(dest.path);
			if (!isPublished(dest)) continue;
			live.links[linkpath] = dest.path;
			live.files[dest.path] ??= {
				route: pageRouteOf(dest.path),
				sources: statblockSources(await app.vault.cachedRead(dest)),
			};
		}
		for (const { sources: all } of Object.values(live.files)) {
			for (const s of all) {
				for (const chunk of [...yamlChunks(s), ...yamlChunks(markLinks(s))]) {
					const value = tryParse(chunk);
					if (value !== undefined) live.yaml[chunk] = value;
				}
			}
		}
		el.setAttribute(LIVE_STATBLOCK_ATTR, JSON.stringify(live));
	}
	return { notes: [...notes], unresolved: [...unresolved] };
}
