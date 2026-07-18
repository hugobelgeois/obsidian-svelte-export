import { base } from "$app/paths";

/**
 * Must stay byte-for-byte identical to BASE_PATH_SENTINEL in the plugin's
 * src/constants.ts (a separate, esbuild-bundled module graph — this file
 * lives in the exported SvelteKit project instead and can't import it
 * directly). pageexporter.ts stamps every route/image URL it generates with
 * this placeholder at export time, before the site's real `base` path is
 * known; swapped for the real thing below, once per render.
 */
const BASE_SENTINEL = "%%BASE%%";

/**
 * Swaps BASE_SENTINEL for the site's real base path. renderMarkdown() does
 * this itself on its own output — this standalone export exists for the
 * rare spot that embeds wikilink-derived HTML directly instead of going
 * through a full renderMarkdown() call (section headings in pageexporter.ts,
 * which can contain a wikilink and are spliced straight into the compiled
 * Svelte template rather than rendered at runtime).
 */
export function applyBase(html: string): string {
	// split/join instead of a regex replace — the sentinel is a plain
	// literal string, never a pattern, and this can't misfire on any
	// regex-special characters `base` itself might contain.
	return html.split(BASE_SENTINEL).join(base);
}

/**
 * Lightweight Markdown → HTML renderer.
 */
export function renderMarkdown(md: string): string {
	let src = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	src = src.replace(/^---\n[\s\S]*?\n---\n?/, "");

	const lines = src.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (/^```/.test(line)) {
			const lang = line.slice(3).trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) {
				codeLines.push(escapeHtml(lines[i]));
				i++;
			}
			const langAttr = lang ? ` class="language-${lang}"` : "";
			out.push(
				`<pre><code${langAttr}>${codeLines.join("\n")}</code></pre>`,
			);
			i++;
			continue;
		}

		if (/^>/.test(line)) {
			const bqLines: string[] = [];
			while (i < lines.length && /^>/.test(lines[i])) {
				bqLines.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			// Each > line is a visual line in Obsidian — preserve with <br>
			const bqContent = bqLines.map((l) => inline(l)).join("<br>");
			out.push(`<blockquote>${bqContent}</blockquote>`);
			continue;
		}

		const hMatch = line.match(/^(#{1,6})\s+(.*)/);
		if (hMatch) {
			const level = hMatch[1].length;
			const text = hMatch[2];
			const id = text
				.toLowerCase()
				.replace(/[^\w\s-]/g, "")
				.replace(/\s+/g, "-")
				.replace(/^-+|-+$/g, "");
			out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
			i++;
			continue;
		}

		if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		if (
			/\|/.test(line) &&
			i + 1 < lines.length &&
			/^\|?[\s:|-]+\|/.test(lines[i + 1])
		) {
			const tableLines: string[] = [];
			while (i < lines.length && /\|/.test(lines[i])) {
				tableLines.push(lines[i]);
				i++;
			}
			out.push(renderTable(tableLines));
			continue;
		}

		if (/^\s*[*\-+]\s/.test(line)) {
			const listLines: string[] = [];
			while (i < lines.length && /^\s*[*\-+]\s/.test(lines[i])) {
				listLines.push(lines[i]);
				i++;
			}
			out.push(renderList(listLines, false));
			continue;
		}

		if (/^\s*\d+\.\s/.test(line)) {
			const listLines: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
				listLines.push(lines[i]);
				i++;
			}
			out.push(renderList(listLines, true));
			continue;
		}

		if (line.trim() === "") {
			i++;
			continue;
		}

		// Raw HTML line emitted by processWikilinks (e.g. <img>, <a>, <div class="wiki-embed">)
		// Pass it through untouched — do not run inline() on it.
		if (/^<[a-zA-Z]/.test(line.trim())) {
			out.push(line);
			i++;
			continue;
		}

		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!/^[>#`|]/.test(lines[i]) &&
			!/^\s*[*\-+]\s/.test(lines[i]) &&
			!/^\s*\d+\.\s/.test(lines[i]) &&
			!/^#{1,6}\s/.test(lines[i])
		) {
			paraLines.push(lines[i]);
			i++;
		}

		if (paraLines.length) {
			out.push(`<p>${inline(paraLines.join(" "))}</p>`);
		} else {
			i++;
		}
	}

	return applyBase(out.join("\n"));
}

// ── Inline renderer ────────────────────────────────────────────────────────

/**
 * Process inline markdown on a string that may already contain HTML tags
 * (emitted by processWikilinks in the plugin).
 *
 * Strategy:
 * 1. Stash existing HTML tags so markdown rules don't touch them
 * 2. Apply markdown inline rules on plain text only
 * 3. Restore stashed HTML tags
 */
function inline(text: string): string {
	const stash: string[] = [];

	// Stash complete HTML tags (self-closing and paired) and HTML entities
	text = text.replace(/(<[^>]+>|&[a-zA-Z#0-9]+;)/g, (match) => {
		stash.push(match);
		return `STASH${stash.length - 1}END`;
	});

	// Apply markdown inline rules on the now tag-free text
	text = text
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_]+)__/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/_([^_]+)_/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/~~([^~]+)~~/g, "<del>$1</del>")
		.replace(/  \n/g, "<br>");

	// Restore stashed HTML
	text = text.replace(/STASH(\d+)END/g, (_, idx) => stash[parseInt(idx)]);

	return text;
}

// ── Block helpers ──────────────────────────────────────────────────────────

function renderList(lines: string[], ordered: boolean): string {
	const tag = ordered ? "ol" : "ul";
	const items = lines.map((l) => {
		const text = l.replace(/^\s*([*\-+]|\d+\.)\s/, "");
		const taskMatch = text.match(/^\[([ xX])\]\s(.*)/);
		if (taskMatch) {
			const checked =
				taskMatch[1].toLowerCase() === "x" ? " checked" : "";
			return `<li><input type="checkbox" disabled${checked}> ${inline(taskMatch[2])}</li>`;
		}
		return `<li>${inline(text)}</li>`;
	});
	return `<${tag}>${items.join("")}</${tag}>`;
}

function renderTable(lines: string[]): string {
	const PIPE = "\x00PIPE\x00";
	const rows = lines.map(
		(l) =>
			l
				.replace(/\\\|/g, PIPE) // stash escaped \| before splitting
				.replace(/^\|/, "")
				.replace(/\|$/, "")
				.split("|")
				.map((c) => c.trim().replace(new RegExp(PIPE, "g"), "|")), // restore
	);
	if (rows.length < 2) return "";
	const head = rows[0].map((c) => `<th>${inline(c)}</th>`).join("");
	const body = rows
		.slice(2)
		.map(
			(r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`,
		)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
