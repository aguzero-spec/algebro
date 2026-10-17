// A small Markdown-to-HTML converter for the Preview button.
// Handles what Claude writes in packets: headings, bold/italic, inline code,
// bullet and numbered lists, tables, quotes, horizontal rules, paragraphs.
// Everything is HTML-escaped first, so text can never inject page code.

function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Heading: # .. ######
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++; continue;
    }

    // Horizontal rule: --- or *** or ___
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push("<hr>"); i++; continue; }

    // Table: a row of pipes followed by a |---|---| separator row
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html.push("<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>");
      continue;
    }

    // Quote: > text
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    // Lists: - item / * item / 1. item (indented items nest one level)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      html.push(list(lines, i));
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) i++;
      continue;
    }

    // Paragraph: consecutive plain lines
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
           !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) {
      para.push(inline(lines[i]));
      i++;
    }
    html.push(`<p>${para.join("<br>")}</p>`);
  }
  return html.join("\n");
}

// Build one list (and nested lists) starting at lines[start].
function list(lines, start) {
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  const ordered = /^\s*\d+[.)]/.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Nested list belongs to the previous item.
      const nested = list(lines, i);
      items[items.length - 1] += nested;
      while (i < lines.length && (lines[i].match(/^\s*/)[0].length > baseIndent) && lines[i].trim()) i++;
      continue;
    }
    items.push(inline(m[3]));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>` + items.map((t) => `<li>${t}</li>`).join("") + `</${tag}>`;
}

function splitRow(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// Inline formatting within one line of text.
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // (No __bold__ rule: it would mangle worksheet blanks like ______.)
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
