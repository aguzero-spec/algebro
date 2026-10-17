// Reads the Markdown Claude writes into simple blocks that every exporter can draw.
// The browser version of app/markdown_blocks.py: keep the two in step.
//
// A block is an object with a "type":
//   heading     {level: 1-6, runs}
//   paragraph   {runs}                         (a line break inside is a run {text: "\n"})
//   list_item   {level: 0.., ordered, number, runs}
//   table       {header: [runs, ...], rows: [[runs, ...], ...]}
//   quote       {runs}
//   rule        {}
// A run is a piece of text with formatting: {text, bold, italic, code}.

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}/;
const QUOTE = /^\s*>\s?(.*)$/;

// Invisible characters that text copied from Word or PDFs can contain (Word files can't hold them).
const CONTROL_CHARS = /[\x00-\x08\x0e-\x1f\x7f]/g;

export function clean(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/[\x0b\x0c]/g, "\n").replace(CONTROL_CHARS, "");
}

export function parse(markdown) {
  const lines = clean(markdown).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }

    if ((m = line.match(HEADING))) {
      blocks.push({ type: "heading", level: m[1].length, runs: inline(m[2].trim()) });
      i++;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); i++; continue; }

    if (startsTable(lines, i)) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const width = header.length;
      const even = rows.map((row) => [...row, ...Array(width).fill("")].slice(0, width)); // same width everywhere
      blocks.push({ type: "table", header: header.map((c) => inline(c)), rows: even.map((row) => row.map((c) => inline(c))) });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) { quoted.push(m[1]); i++; }
      blocks.push({ type: "quote", runs: joinLines(quoted) });
      continue;
    }

    if (LIST_ITEM.test(line)) { i = parseList(lines, i, blocks); continue; }

    // Paragraph: consecutive plain lines.
    const para = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !QUOTE.test(lines[i])
           && !LIST_ITEM.test(lines[i]) && !RULE.test(lines[i]) && !startsTable(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", runs: joinLines(para) });
  }
  return blocks;
}

function startsTable(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]);
}

function splitRow(row) {
  row = row.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

// Add list items (with nesting levels and numbering) starting at line i. Returns the next line.
function parseList(lines, i, blocks) {
  const indents = [];   // indentation of each open nesting level
  const counters = {};  // next number per level, for numbered lists
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m) {
      // An indented line right after an item continues that item's text.
      const last = blocks[blocks.length - 1];
      if (lines[i].startsWith("  ") && lines[i].trim() && last?.type === "list_item") {
        last.runs.push({ text: " " }, ...inline(lines[i].trim()));
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].length;
    while (indents.length && indent < indents[indents.length - 1]) {
      delete counters[indents.length - 1];
      indents.pop();
    }
    if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
    const level = indents.length - 1;
    const marker = m[2];
    const ordered = /\d/.test(marker[0]);
    let number = 0;
    if (ordered) {
      number = counters[level] ?? parseInt(marker.slice(0, -1), 10);
      counters[level] = number + 1;
    }
    blocks.push({ type: "list_item", level, ordered, number, runs: inline(m[3]) });
    i++;
  }
  return i;
}

function joinLines(lines) {
  const runs = [];
  lines.forEach((line, n) => {
    if (n) runs.push({ text: "\n" });
    runs.push(...inline(line));
  });
  return runs;
}

// Inline formatting: `code`, **bold**, *italic*, _italic_ (but never ______ blanks).
// W is a letter, digit, or underscore in any language (like Python's \w; JavaScript's \w is English-only).
const W = "\\p{L}\\p{N}_";
const INLINE = new RegExp(
  "`(?<code>[^`]+)`"
  + "|\\*\\*(?<bold>.+?)\\*\\*"
  + `|(?<![*${W}])\\*(?<italic>[^*\\s](?:[^*]|\\*\\*[^*]+\\*\\*)*?)\\*(?!\\*)`
  + `|(?<![_${W}])_(?<uitalic>[^_\\s][^_]*?)_(?![_${W}])`, "gu");

export function inline(text, bold = false, italic = false) {
  const runs = [];
  let pos = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > pos) runs.push(run(text.slice(pos, m.index), bold, italic));
    const g = m.groups;
    if (g.code !== undefined) runs.push({ ...run(g.code, bold, italic), code: true });
    else if (g.bold !== undefined) runs.push(...inline(g.bold, true, italic));
    else runs.push(...inline(g.italic ?? g.uitalic, bold, true));
    pos = m.index + m[0].length;
  }
  if (pos < text.length) runs.push(run(text.slice(pos), bold, italic));
  return runs;
}

const run = (text, bold, italic) => ({ text, bold, italic, code: false });

// Runs back to unformatted text.
export const plain = (runs) => runs.map((r) => r.text).join("");
