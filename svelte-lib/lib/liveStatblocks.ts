// Runs the JavaScript blocks of Fantasy Statblocks layouts in the visitor's
// browser (the plugin's src/liveStatblocks.ts exports what that takes).
// In Obsidian that code reads notes through `app` and edits its own note,
// which renders the statblock again; here it's given a stand-in `app` whose
// notes only exist in memory (just their statblocks), and an "edit" renders
// the statblock again. Nothing is kept once the page is left.
import { goto } from "$app/navigation";
import { base } from "$app/paths";
import {
	LIVE_STATBLOCK_ATTR,
	markLinks,
	statblockSources,
	unmarkLinks,
	yamlChunks,
	type LayoutBlock,
	type LiveStatblock,
} from "./statblockSource";

type Monster = Record<string, any>;

/** Makes the live statblocks of the current page interactive. */
export function startLiveStatblocks(): void {
	document
		.querySelectorAll<HTMLElement>(`.md-page [${LIVE_STATBLOCK_ATTR}]`)
		.forEach((el) => {
			const json = el.getAttribute(LIVE_STATBLOCK_ATTR)!;
			// Started once only.
			el.removeAttribute(LIVE_STATBLOCK_ATTR);
			try {
				start(el, JSON.parse(json) as LiveStatblock);
			} catch (e) {
				console.error("Statblock left static:", e);
			}
		});
}

function start(el: HTMLElement, data: LiveStatblock) {
	const vault = createVault(data, () => render());
	const runner = createRunner(vault);
	const renderer = createRenderer(el, data.layout, runner);
	/** Renders caused by one another — the code may edit its note while
	 * rendering, which must settle instead of looping forever. */
	let chained = 0;
	let reset: ReturnType<typeof setTimeout> | undefined;

	function render() {
		if (!el.isConnected || ++chained > 20) return;
		clearTimeout(reset);
		reset = setTimeout(() => (chained = 0), 500);
		const source = vault.source();
		if (source === undefined) return;
		try {
			renderer.render(vault.parseYaml(markLinks(source)) as Monster);
		} catch (e) {
			// What's on the page stays as it is.
			console.error(e);
		}
	}
	render();
}

// ── Stand-in for Obsidian's API ────────────────────────────────────────────

type Vault = ReturnType<typeof createVault>;

function createVault(data: LiveStatblock, onChange: () => void) {
	const toText = (sources: string[]) =>
		sources.map((s) => "```statblock\n" + s + "```\n").join("\n");
	const texts = new Map(
		Object.entries(data.files).map(([p, f]) => [p, toText(f.sources)]),
	);
	const files = new Map(
		Object.keys(data.files).map((path) => {
			const name = path.slice(path.lastIndexOf("/") + 1);
			const basename = name.replace(/\.md$/, "");
			return [path, { path, name, basename, extension: "md" }];
		}),
	);
	type File = { path: string };
	const read = (path: string) => texts.get(path) ?? "";
	const write = (path: string, text: string) => {
		if (!texts.has(path) || texts.get(path) === text) return;
		texts.set(path, text);
		// Once the code that wrote it is done, as in Obsidian.
		if (path === data.path) setTimeout(onChange);
	};

	const parseYaml = (source: string): unknown => {
		const result: Record<string, unknown> = {};
		for (const chunk of yamlChunks(source)) {
			const known = data.yaml[chunk];
			Object.assign(
				result,
				// Cloned: the code changes the data it gets.
				known !== undefined ? structuredClone(known) : parseChunk(chunk),
			);
		}
		return result;
	};

	const app = {
		workspace: {
			getActiveFile: () => files.get(data.path) ?? null,
			openLinkText: async (link: string) => {
				const target = link.split("#")[0]!;
				const file = data.files[data.links[target] ?? target];
				if (file) await goto(base + file.route);
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (link: string) =>
				files.get(data.links[link] ?? "") ?? null,
			// Front matter isn't published.
			getFileCache: () => ({}),
		},
		vault: {
			adapter: {
				getFullPath: (path: string) => path,
				read: async (path: string) => read(path),
			},
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			getFileByPath: (path: string) => files.get(path) ?? null,
			read: async (f: File) => read(f.path),
			cachedRead: async (f: File) => read(f.path),
			modify: async (f: File, text: string) => write(f.path, text),
			process: async (f: File, change: (text: string) => string) => {
				const text = change(read(f.path));
				write(f.path, text);
				return text;
			},
		},
	};
	const modules: Record<string, unknown> = {
		obsidian: { parseYaml },
		fs: { readFileSync: read, existsSync: (p: string) => texts.has(p) },
	};
	const require = (name: string) => {
		if (name in modules) return modules[name];
		throw new Error(`Module not available on the site: ${name}`);
	};
	return {
		app,
		require,
		parseYaml,
		source: () => statblockSources(read(data.path))[data.index],
	};
}

/** Parses an entry written by the code itself: "key: value", the value
 * being a plain scalar or JSON, or a list of those. */
function parseChunk(chunk: string): Record<string, unknown> {
	const m = chunk.match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+([\s\S]*))?$/);
	if (!m) throw new Error(`Can't parse: ${chunk}`);
	const key = m[1]!.replace(/^["']|["']$/g, "");
	const value = (m[2] ?? "").trim();
	if (value.startsWith("- ")) {
		return { [key]: value.split(/\n\s*/).map((l) => scalar(l.slice(1))) };
	}
	return { [key]: scalar(value) };
}

function scalar(text: string): unknown {
	const s = text.trim();
	if (s === "" || s === "~") return null;
	try {
		return JSON.parse(s);
	} catch {
		// not JSON
	}
	const list = s.match(/^\[([\s\S]*)\]$/);
	if (list) {
		return list[1]!
			.split(",")
			.filter((v) => v.trim())
			.map(scalar);
	}
	const quoted = s.match(/^'([\s\S]*)'$/);
	return quoted ? quoted[1]!.replace(/''/g, "'") : s;
}

type Runner = ReturnType<typeof createRunner>;

/** Runs a layout's code with the stand-ins in place of Obsidian's globals. */
function createRunner(vault: Vault) {
	const own: Record<PropertyKey, unknown> = {
		app: vault.app,
		require: vault.require,
	};
	const win: unknown = new Proxy(own, {
		get(target, key) {
			if (key in target) return target[key];
			const value = (window as any)[key];
			// setTimeout & co. only work on the real window; classes (which
			// have a prototype) are left as they are.
			return typeof value === "function" && !value.prototype
				? value.bind(window)
				: value;
		},
		has: (target, key) => key in target || key in window,
	});
	own.window = win;
	const plugin = { app: vault.app };
	return {
		plugin,
		run(code: string, params: Record<string, unknown>): unknown {
			// Nested functions: the code may declare its own `app`.
			const fn = new Function(
				"window",
				"app",
				"require",
				`return function (${Object.keys(params).join(", ")}) {\n${code}\n};`,
			)(win, vault.app, vault.require);
			return fn(...Object.values(params));
		},
	};
}

// ── Rendering ──────────────────────────────────────────────────────────────
// The same DOM as Fantasy Statblocks', so that its stylesheet applies.

/** Fantasy Statblocks' own conversion of a name to a CSS class. */
const className = (s: unknown) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/[^A-Za-z0-9\s_-]/g, "")
		.replace(/\s+/g, "-");

/** Fantasy Statblocks' own conversion of a value to text. */
function stringify(v: unknown, depth = 0, joiner = " ", parens = true): string {
	if (depth === 5 || v == null) return "";
	if (typeof v === "string" || typeof v === "number") return String(v);
	if (Array.isArray(v)) {
		const text = v.map((x) => stringify(x, depth + 1)).join(joiner);
		return parens ? `(${text})` : text;
	}
	if (typeof v === "object") {
		return Object.values(v)
			.map((x) => stringify(x, depth + 1))
			.join(" ");
	}
	return "";
}

function make(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	parent?.append(el);
	return el;
}

const div = (cls: string, parent?: HTMLElement) => make("div", cls, parent);

const escapeHtml = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

function createRenderer(el: HTMLElement, layout: LayoutBlock[], runner: Runner) {
	const columns = Array.from(
		el.querySelectorAll<HTMLElement>(".statblock-content > .column"),
	);
	if (!columns.length) throw new Error("no statblock content");

	// The scoped style classes Svelte gave the plugin's components, which
	// change with its versions: taken from the statblocks on the page, or
	// else (none of them has that component) those of 4.10.3.
	const scope = (selector: string, fallback: string) => {
		const found = document.querySelector(`.statblock ${selector}`);
		return (
			Array.from(found?.classList ?? []).find((c) => c.startsWith("svelte-")) ??
			fallback
		);
	};
	const css = {
		heading: scope(".statblock-heading", "svelte-14k5qsm"),
		subheading: scope(".subheading", "svelte-1fyuyh"),
		section: scope(".section-header", "svelte-1ascaxr"),
		property: scope(".line > .property-name", "svelte-1rketb6"),
		trait: scope(".trait", "svelte-1d2gp4n"),
		table: scope(".statblock-table", "svelte-1jjvt5k"),
		rule: scope(".tapered-rule", "svelte-k72li0"),
		markdown: scope(".statblock-markdown", "svelte-1c3hzq4"),
		text: scope(".statblock-rendered-text-content", "svelte-1lnliuc"),
		details: scope("details", "svelte-1674zvq"),
	};

	// Values Obsidian already rendered (with their links, dice…) are reused
	// as they are; so are links, in values it didn't.
	const rendered = new Map<string, string>();
	const links = new Map<string, string>();
	document.querySelectorAll(".md-page .statblock-markdown").forEach((n) => {
		const key = n.textContent?.trim();
		if (key) rendered.set(key, n.innerHTML);
		n.querySelectorAll("a").forEach((a) => {
			links.set(a.textContent?.trim() ?? "", a.outerHTML);
		});
	});
	const image = el.querySelector(".image");

	/** The little Markdown statblock values usually have. */
	function inlineMarkdown(text: string): string {
		// Links are done first and put back last: a URL isn't Markdown.
		const kept: string[] = [];
		const keep = (html: string) => `\u0001${kept.push(html) - 1}\u0001`;
		const source = unmarkLinks(text)
			.replaceAll("\u0001", "")
			.replace(
				/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
				(_m, link: string, label?: string) => {
					const shown = (label ?? link).trim();
					return keep(links.get(shown) ?? escapeHtml(shown));
				},
			)
			.replace(
				/\[([^\]]*)\]\((https?:[^)\s]+)\)/g,
				(_m, label: string, url: string) =>
					keep(`<a href="${escapeHtml(url)}">${escapeHtml(label || url)}</a>`),
			);
		return escapeHtml(source)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.+?)\*/g, "<em>$1</em>")
			.replace(/\n/g, "<br>")
			.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => kept[Number(i)] ?? "");
	}

	function markdown(value: unknown, parent: HTMLElement) {
		const target = div(`statblock-markdown ${css.markdown}`, parent);
		target.innerHTML = `<p dir="auto">${inlineMarkdown(stringify(value))}</p>`;
		const known = rendered.get(target.textContent?.trim() ?? "");
		if (known) target.innerHTML = known;
	}

	function plainText(value: string, parent: HTMLElement) {
		const target = div(
			`statblock-rendered-text-content inline ${css.text}`,
			parent,
		);
		target.innerHTML = inlineMarkdown(value);
	}

	function hasContent(item: LayoutBlock, monster: Monster): boolean {
		if (!item.conditioned) return true;
		if (item.nested) return item.nested.some((n) => hasContent(n, monster));
		if (["ifelse", "javascript"].includes(item.type)) return true;
		if (!item.properties?.length) return true;
		return item.properties.some((p) => {
			const v = monster[p];
			return typeof v === "number" || !!(v as string | unknown[])?.length;
		});
	}

	/** Port of Fantasy Statblocks' own function: the elements to lay out,
	 * which end up side by side in the column — a group's children are
	 * moved out of it. */
	function build(
		item: LayoutBlock,
		monster: Monster,
		container?: HTMLElement,
		classes: string[] = [],
	): HTMLElement[] {
		if (!hasContent(item, monster)) return [];
		const box = (parent?: HTMLElement, cls: string[] = classes) =>
			div(
				`statblock-item-container ${className(item.type)}-container ${cls.join(" ")}`,
				parent,
			);
		const inner = item.cls ? [...classes, String(item.cls)] : classes;
		const prop = item.properties?.[0] ?? "";
		const value: unknown = monster[prop];
		const propClass = item.doNotAddClass ? "" : className(prop);
		const root = box(container);
		const out: HTMLElement[] = [root];

		const sectionHeading = (parent: HTMLElement) => {
			const name = String(item.heading ?? "");
			const heading = item.headingProp ? stringify(monster[name]) : name;
			if (!heading) return;
			plainText(
				heading,
				make("h3", `section-header ${className(heading)} ${css.section}`, parent),
			);
		};

		switch (item.type) {
			case "group":
				sectionHeading(root);
				for (const n of item.nested ?? []) {
					out.push(...build(n, monster, root, inner));
				}
				break;
			case "inline": {
				sectionHeading(root);
				const row = box(root, ["statblock-item-inline", ...inner]);
				for (const n of item.nested ?? []) {
					build(
						n,
						monster,
						div(`statblock-inline-item ${className(n.type)}-container`, row),
					);
				}
				out.push(row);
				break;
			}
			case "collapse": {
				const details = make("details", css.details, root) as HTMLDetailsElement;
				details.open = !!item.open;
				const summary = make("summary", css.details, details);
				summary.append(String(item.heading ?? ""));
				div(
					`handle ${css.details}`,
					div(`collapser ${css.details}`, summary),
				);
				const elements = (item.nested ?? []).flatMap((n) => build(n, monster));
				details.append(...elements);
				break;
			}
			case "ifelse": {
				const conditions = item.conditions ?? [];
				for (const [i, { condition = "", nested }] of conditions.entries()) {
					const isElse = i === conditions.length - 1 && !condition;
					const matches =
						isElse ||
						runner.run(condition, { monster, plugin: runner.plugin }) === true;
					if (!matches) continue;
					for (const n of nested) out.push(...build(n, monster, root));
					break;
				}
				break;
			}
			case "javascript": {
				const target = div("statblock-javascript", root);
				const result = runner.run(item.code ?? "", {
					monster,
					property: runner.plugin,
				});
				if (result instanceof HTMLElement) target.append(result);
				break;
			}
			case "heading": {
				const flex = div(`flex-container ${css.heading}`, root);
				for (const p of item.properties ?? []) {
					if (!(p in monster)) continue;
					const h = make(
						`h${Number(item.size) || 1}`,
						`heading statblock-heading ${className(p)} ${css.heading}`,
						flex,
					);
					plainText(stringify(monster[p]), h);
				}
				break;
			}
			case "subheading": {
				const texts = (item.properties ?? [])
					.filter((p) => p in monster)
					.map((p) => stringify(monster[p], 0, ", ", false));
				if (!texts.length) break;
				plainText(
					texts.join(String(item.separator ?? " ")),
					div(`subheading ${css.subheading}`, root),
				);
				break;
			}
			case "image":
				// A copy: the one on the page stays there if rendering fails.
				if (image) root.append(image.cloneNode(true));
				break;
			case "property": {
				let shown: unknown = stringify(value, 0, ", ", false);
				if (item.callback) {
					shown = runner.run(String(item.callback), { monster }) ?? shown;
				}
				if (!String(shown).length) {
					if (item.conditioned) break;
					shown = item.fallback ?? "-";
				}
				const line = div(`line ${propClass} ${css.property}`, root);
				make("span", `property-name ${css.property}`, line).textContent = String(
					item.display ?? prop,
				);
				line.append(" ");
				markdown(shown, line);
				break;
			}
			case "table": {
				const list = Array.isArray(value) ? (value as unknown[]) : [];
				const cells: unknown[][] = [];
				list.forEach((v, i) => {
					if (Array.isArray(v)) v.forEach((x, j) => (cells[j] ??= []).push(x));
					else cells[i] = [v];
				});
				const headers =
					(item.headers as string[] | undefined) ?? cells.map((_c, i) => i);
				const table = div(`statblock-table ${propClass} ${css.table}`, root);
				cells.slice(0, headers.length).forEach((values, i) => {
					const cell = div(`table-item ${css.table}`, table);
					make("span", `statblock-table-header ${css.table}`, cell).textContent =
						String(headers[i]);
					cell.append(" ");
					for (const v of values) {
						const span = make("span", "", cell);
						markdown(v, span);
						if (!item.calculate) continue;
						span.append(" ");
						make("span", `calculated-modifier ${css.table}`, span).textContent =
							modifier(v, item, monster);
					}
					cell.append(" ");
				});
				break;
			}
			case "text": {
				sectionHeading(root);
				let text = item.text ? String(item.text) : stringify(value);
				if (!text && !item.conditioned) text = String(item.fallback ?? "-");
				if (text) markdown(text, div("line", root));
				break;
			}
			case "traits": {
				if (!Array.isArray(value) || !value.length) return [];
				const group = box(root);
				out.push(group);
				if (item.heading) {
					sectionHeading(div("statblock-section-heading", group));
				}
				const traitBox = (parent?: HTMLElement) =>
					div("statblock-item-container statblock-trait-prop", parent);
				if (item.subheadingText) {
					const desc = String(item.subheadingText).replace(
						/\{\{monster\}\}/g,
						() => stringify(monster.name),
					);
					const sub = traitBox(group);
					trait({ name: "", desc }, "trait-subheading", item, monster, sub);
					out.push(sub);
				}
				value.forEach((t: Monster, i) => {
					const target = traitBox(i === 0 ? group : container);
					trait(t, prop, item, monster, target);
					if (i > 0) out.push(target);
				});
				break;
			}
		}
		if (item.hasRule) {
			const rule = div(
				`statblock-item-container rule-container ${classes.join(" ")}`,
			);
			div(`tapered-rule ${css.rule}`, rule);
			out.push(rule);
		}
		return out.filter((n) => n.hasChildNodes());
	}

	function trait(
		t: Monster,
		prop: string,
		item: LayoutBlock,
		monster: Monster,
		parent: HTMLElement,
	) {
		let desc: unknown = t.desc;
		if (item.callback) {
			desc = runner.run(String(item.callback), { monster, property: t }) ?? desc;
		}
		const cls = item.doNotAddClass
			? ""
			: `${className(t.name)} ${className(prop)}`;
		const line = div(`property ${cls} trait ${css.trait}`, parent);
		if (t.name) {
			markdown(t.name, div(`property-name trait-name ${css.trait}`, line));
		}
		line.append(" ");
		markdown(desc, line);
		line.append(" ");
		if (Array.isArray(t.traits)) {
			const nested = div(`statblock-nested-traits ${css.trait}`, line);
			for (const n of t.traits) trait(n, prop, item, monster, nested);
		}
	}

	function modifier(v: unknown, item: LayoutBlock, monster: Monster): string {
		if (typeof v !== "number") return "";
		let mod = Math.floor((v - 10) / 2);
		const code = item.modifier ? String(item.modifier) : "";
		if (code) {
			mod = Number(
				runner.run(code.includes("return") ? code : `return ${code}`, {
					stat: v,
					monster,
				}),
			);
		}
		return `${mod >= 0 ? "+" : "-"}${Math.abs(mod)}`;
	}

	const query = (selector: string) =>
		columns.flatMap((c) => Array.from(c.querySelectorAll<HTMLElement>(selector)));
	const openDetails = () =>
		query("details").map((d) => (d as HTMLDetailsElement).open);
	const INPUTS = "input, select, textarea, button";

	/** Spreads what's in the first column over all of them. */
	function balance() {
		if (columns.length < 2) return;
		const items = Array.from(columns[0]!.children) as HTMLElement[];
		const heights = items.map((n) => n.offsetHeight);
		const height = heights.reduce((a, b) => a + b, 0) / columns.length;
		let top = 0;
		items.forEach((n, i) => {
			const index = height ? Math.floor(top / height) : 0;
			columns[Math.min(index, columns.length - 1)]!.append(n);
			top += heights[i]!;
		});
	}

	return {
		render(monster: Monster) {
			// The page isn't touched until all of it could be rendered: the
			// code may well need something of Obsidian the site doesn't have.
			const targets = layout.flatMap((b) => build(b, monster));

			// What the visitor did to the previous rendering is kept.
			const open = openDetails();
			const focused = query(INPUTS).indexOf(
				document.activeElement as HTMLElement,
			);
			for (const c of columns) c.replaceChildren();
			columns[0]!.append(...targets);
			query(".statblock-item-container:empty").forEach((n) => n.remove());
			balance();
			query("details").forEach((d, i) => {
				const details = d as HTMLDetailsElement;
				details.open = open[i] ?? details.open;
			});
			if (focused >= 0) query(INPUTS)[focused]?.focus({ preventScroll: true });
		},
	};
}
