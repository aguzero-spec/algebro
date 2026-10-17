// PowerPoint (.pptx) export, widescreen 16:9, with the bundled pptxgenjs library (vendor/).
// The browser version of app/export_pptx.py: same slide planning, keep them in step.
//
// Works for any section:
// - Each heading (levels 1-3) starts a new slide.
// - Long content continues on extra slides marked "(cont.)"; tables get their own
//   slides, with the header row repeated when split. No content is dropped.
// - A paragraph starting with "Notes:" becomes that slide's speaker notes.
// The "Presentation Slides" section is written by Claude in exactly this shape.

import { columnWeights, hexColor } from "./export.js?v=c70461b0d2";
import { plain } from "./markdown_blocks.js?v=c70461b0d2";
import { loadScript } from "./vendor.js?v=c70461b0d2";

const MAX_ITEMS = 7;          // text lines per slide before continuing on the next
const MAX_CHARS = 650;        // characters per slide before continuing
const MAX_TABLE_ROWS = 6;     // table rows per slide (header is repeated)
const LEFTOVER_ITEMS = 2;     // a "(cont.)" slide this small joins the slide before it, if it fits
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const CONTENT_WIDTH_IN = SLIDE_W - 1.2; // slide width minus side margins
const CONTENT_HEIGHT_IN = 5.4;          // room below the title
const TEXT_UNDER_TABLE_PT = 18;
const NOTES = /^\s*(speaker\s+)?notes?\s*:\s*/i;

const hex = (rgb) => rgb.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();

export async function toPptx(doc) {
  const PptxGenJS = await loadScript("vendor/pptxgenjs-4.0.1/pptxgen.bundle.js", "PptxGenJS");
  const style = doc.style;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 inches
  pptx.title = doc.title;
  const ctx = { pptx, font: style.font || "Arial", color: hex(hexColor(style.heading_color)),
                headerFill: hex(hexColor(style.table_header_color, "D9E2F3")) };

  const subtitle = doc.wholePacket ? doc.info.slice(0, 3).join("\n") : doc.sections[0][0];
  titleSlide(ctx, doc.title, subtitle);
  for (const [title, blocks] of doc.sections) {
    if (doc.wholePacket && doc.sections.length > 1) sectionSlide(ctx, title);
    for (const plan of planSlides(title, blocks)) contentSlide(ctx, plan);
  }
  return pptx.write({ outputType: "blob" });
}

// ---- Deciding what goes on each slide ----

export function planSlides(sectionTitle, blocks) {
  const slides = [];
  const fresh = (title) => ({ title, items: [], table: null, notes: [] });
  const flush = (slide) => {
    if (slide.items.length || slide.table) slides.push(slide);
    else if (slide.notes.length && slides.length) slides[slides.length - 1].notes.push(...slide.notes); // notes after a table
  };
  const cont = (title) => (title.endsWith("(cont.)") ? title : `${title} (cont.)`);

  let current = fresh(sectionTitle);
  for (let b of blocks) {
    if (b.type === "heading" && b.level <= 3) {
      flush(current);
      current = fresh(plain(b.runs).trim());
    } else if (b.type === "paragraph" && NOTES.test(plain(b.runs))) {
      current.notes.push(plain(b.runs).replace(NOTES, ""));
    } else if (b.type === "table") {
      flush(current);
      const rows = b.rows;
      for (let n = 0; n < Math.max(rows.length, 1); n += MAX_TABLE_ROWS) { // header-only tables get one slide too
        const slide = fresh(n === 0 ? current.title : cont(current.title));
        slide.table = { header: b.header, rows: rows.slice(n, n + MAX_TABLE_ROWS) };
        slides.push(slide);
      }
      current = fresh(cont(current.title));
    } else if (b.type !== "rule") {
      if (b.type === "heading") b = { type: "paragraph", runs: b.runs.map((r) => ({ ...r, bold: true })) }; // small headings
      const chars = current.items.reduce((sum, i) => sum + plain(i.runs).length, 0);
      if (current.items.length && (current.items.length >= MAX_ITEMS || chars + plain(b.runs).length > MAX_CHARS)) {
        flush(current);
        current = fresh(cont(current.title));
      }
      current.items.push(b);
    }
  }
  flush(current);
  return joinShortLeftovers(slides);
}

// Avoid "(cont.)" slides holding just a line or two: move those lines onto the
// previous slide (under its table, or at the end of its list) when they fit.
function joinShortLeftovers(slides) {
  const joined = [];
  for (const slide of slides) {
    const prev = joined[joined.length - 1];
    const base = prev?.title.replace(/ \(cont\.\)$/, "");
    const isLeftover = prev && !slide.table && [prev.title, `${base} (cont.)`].includes(slide.title)
      && slide.items.length <= LEFTOVER_ITEMS;
    if (isLeftover && fits(prev, [...prev.items, ...slide.items])) {
      prev.items.push(...slide.items);
      prev.notes.push(...slide.notes);
    } else {
      joined.push(slide);
    }
  }
  return joined;
}

function fits(slide, items) {
  const chars = items.reduce((sum, i) => sum + plain(i.runs).length, 0);
  if (!slide.table) return items.length <= MAX_ITEMS + LEFTOVER_ITEMS && chars <= MAX_CHARS + 150;
  const { heights } = tableLayout(slide.table);
  return heights.reduce((a, h) => a + h, 0) + 0.3 + textHeightIn(items, TEXT_UNDER_TABLE_PT) <= CONTENT_HEIGHT_IN;
}

// Font size, column widths, and estimated row heights (inches) for a slide table.
function tableLayout(table) {
  const { header, rows } = table;
  const longest = Math.max(10, ...rows.flatMap((row) => row.map((c) => plain(c).length)));
  const size = header.length <= 3 && longest < 80 ? 16 : longest < 140 ? 14 : 12;
  const weights = columnWeights(header, rows);
  const total = weights.reduce((a, w) => a + w, 0);
  const widths = weights.map((w) => (CONTENT_WIDTH_IN * w) / total);
  const heights = [header, ...rows].map((cells) => {
    let lines = 1;
    cells.forEach((runs, c) => {
      const perLine = Math.max(Math.floor(((widths[c] - 0.2) * 72) / (size * 0.5)), 1); // rough characters per line
      const count = plain(runs).split("\n").reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
      lines = Math.max(lines, count);
    });
    return 0.12 + (lines * size * 1.2) / 72;
  });
  return { size, widths, heights };
}

function textHeightIn(items, size) {
  const perLine = Math.max(Math.floor((CONTENT_WIDTH_IN * 72) / (size * 0.5)), 1);
  const lines = items.reduce((sum, i) => sum + Math.max(1, Math.ceil(plain(i.runs).length / perLine)), 0);
  return (lines * size * 1.2) / 72 + (items.length * size * 0.45) / 72;
}

// ---- Drawing the slides (plain white) ----

function titleSlide(ctx, title, subtitle) {
  const slide = ctx.pptx.addSlide();
  slide.addText(title, { x: 0.9, y: 2.2, w: SLIDE_W - 1.8, h: 1.6, fontFace: ctx.font, fontSize: 40, bold: true,
                         color: ctx.color, valign: "bottom", fit: "shrink" });
  slide.addText(subtitle, { x: 0.9, y: 4.0, w: SLIDE_W - 1.8, h: 1.6, fontFace: ctx.font, fontSize: 20, valign: "top" });
}

function sectionSlide(ctx, title) {
  ctx.pptx.addSlide().addText(title, { x: 0.9, y: 2.6, w: SLIDE_W - 1.8, h: 1.6, fontFace: ctx.font, fontSize: 36,
                                       bold: true, color: ctx.color, valign: "middle" });
}

function contentSlide(ctx, plan) {
  const slide = ctx.pptx.addSlide();
  slide.addText(plan.title, { x: 0.6, y: 0.35, w: SLIDE_W - 1.2, h: 1.0, fontFace: ctx.font, fontSize: 30, bold: true,
                              color: ctx.color, valign: "middle", fit: "shrink" });
  const top = 1.5;
  const height = SLIDE_H - 2.0;
  if (plan.table) {
    const tableHeight = drawTable(ctx, slide, plan.table, top);
    if (plan.items.length) { // short leftover text that fit under the table
      const below = top + tableHeight + 0.3;
      drawText(ctx, slide, plan.items, below, top + height - below, TEXT_UNDER_TABLE_PT);
    }
  } else {
    drawText(ctx, slide, plan.items, top, height);
  }
  if (plan.notes.length) slide.addNotes(plan.notes.join("\n"));
}

function drawText(ctx, slide, items, top, height, maxSize = 24) {
  const chars = items.reduce((sum, i) => sum + plain(i.runs).length, 0);
  const size = Math.min(maxSize, chars <= 300 ? 24 : chars <= 500 ? 20 : chars <= 700 ? 18 : 16);
  const paragraphs = [];
  for (const item of items) {
    const level = Math.min(item.level ?? 0, 3);
    const first = {
      paraSpaceAfter: size * 0.45,
      indentLevel: item.type === "list_item" ? level : 0,
      bullet: item.type === "list_item" && !item.ordered ? (level === 0 ? true : { code: "2013" }) : false,
    };
    const runs = [];
    if (item.type === "list_item" && item.ordered) runs.push({ text: `${item.number}. `, options: {} });
    let softBreak = false;
    for (const r of item.runs) {
      if (r.text === "\n") { softBreak = true; continue; }
      runs.push({ text: r.text, options: { bold: Boolean(r.bold), italic: Boolean(r.italic) || item.type === "quote",
                                           color: item.type === "quote" ? "5A5A5A" : undefined, softBreakBefore: softBreak } });
      softBreak = false;
    }
    if (!runs.length) runs.push({ text: "", options: {} });
    Object.assign(runs[0].options, first);
    runs[runs.length - 1].options.breakLine = true;
    paragraphs.push(...runs);
  }
  if (paragraphs.length) delete paragraphs[paragraphs.length - 1].options.breakLine;
  slide.addText(paragraphs, { x: 0.6, y: top, w: SLIDE_W - 1.2, h: height, fontFace: ctx.font, fontSize: size,
                              valign: "top", color: "000000" });
}

// A table cell's formatted text; a line break inside the cell starts a new line.
function cellRuns(runs, header) {
  const out = [];
  let softBreak = false;
  for (const x of runs) {
    if (x.text === "\n") { softBreak = true; continue; }
    out.push({ text: x.text, options: { bold: Boolean(x.bold) || header, italic: Boolean(x.italic), softBreakBefore: softBreak } });
    softBreak = false;
  }
  return out.length ? out : [{ text: "", options: {} }];
}

function drawTable(ctx, slide, table, top) {
  const { size, widths, heights } = tableLayout(table);
  const border = { type: "solid", pt: 0.75, color: "A0A0A0" };
  const rows = [table.header, ...table.rows].map((cells, r) => cells.map((runs) => ({
    text: cellRuns(runs, r === 0),
    options: { fill: { color: r === 0 ? ctx.headerFill : "FFFFFF" } },
  })));
  slide.addTable(rows, { x: 0.6, y: top, w: CONTENT_WIDTH_IN, colW: widths, rowH: heights, fontFace: ctx.font,
                         fontSize: size, color: "000000", border, valign: "top", autoPage: false });
  return heights.reduce((a, h) => a + h, 0);
}
