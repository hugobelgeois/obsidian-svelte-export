/**
 * Lightweight Markdown → HTML renderer.
 * No external dependencies — safe to use in any Svelte/SvelteKit project.
 */
export function renderMarkdown(md: string): string {
  let src = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  src = src.replace(/^---\n[\s\S]*?\n---\n?/, "");

  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\`\`\`/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\`\`\`/.test(lines[i])) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      const langAttr = lang ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${langAttr}>${codeLines.join("\n")}</code></pre>`);
      i++;
      continue;
    }

    if (/^>/.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(bqLines.join("\n"))}</blockquote>`);
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text  = hMatch[2];
      const id    = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && /\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      out.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*[*\-+]\s/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^\s*[*\-+]\s/.test(lines[i])) { listLines.push(lines[i]); i++; }
      out.push(renderList(listLines, false));
      continue;
    }

    if (/^\s*\d+\.\s/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) { listLines.push(lines[i]); i++; }
      out.push(renderList(listLines, true));
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^[>#\`\|*\-+]/.test(lines[i]) &&
      !/^\d+\./.test(lines[i])
    ) { paraLines.push(lines[i]); i++; }

    if (paraLines.length) { out.push(`<p>${inline(paraLines.join(" "))}</p>`); }
    else { i++; }
  }

  return out.join("\n");
}

function renderList(lines: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  const items = lines.map((l) => {
    const text = l.replace(/^\s*([*\-+]|\d+\.)\s/, "");
    const taskMatch = text.match(/^\[([ xX])\]\s(.*)/);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
      return `<li><input type="checkbox" disabled${checked}> ${inline(taskMatch[2])}</li>`;
    }
    return `<li>${inline(text)}</li>`;
  });
  return `<${tag}>${items.join("")}</${tag}>`;
}

function renderTable(lines: string[]): string {
  const rows = lines.map((l) =>
    l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
  );
  if (rows.length < 2) return "";
  const head = rows[0].map((c) => `<th>${inline(c)}</th>`).join("");
  const body = rows.slice(2).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/  \n/g, "<br>");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
