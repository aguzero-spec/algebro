// Turns a packet (or one section of it) into a Word, PDF, PowerPoint, or Markdown file.
// The browser version of app/export.py (and packets.to_markdown): keep them in step.

import { clean, parse, plain } from "./markdown_blocks.js?v=cbc5b6841e";

export const FORMATS = { docx: "Word", pdf: "PDF", pptx: "PowerPoint", md: "Markdown" };

export const REVIEW_NOTE = "Review for accuracy. This packet was written with AI help. Check facts, "
  + "answer keys, and standards before using it with students.";

export class ExportError extends Error {}

// Returns {blob, filename}.
export async function build(packet, sectionId, format, config) {
  if (!(format in FORMATS)) throw new ExportError(`Unknown format “${format}”.`);
  const sections = packet?.sections;
  let order = packet?.order;
  const options = packet?.options ?? {};
  if (!isObject(sections) || !Array.isArray(order) || !isObject(options)) {
    throw new ExportError("This packet's data is damaged, so it can't be exported.");
  }
  order = order.filter((sid) => typeof sid === "string" && Object.hasOwn(sections, sid) && isObject(sections[sid]));
  if (sectionId) {
    if (!order.includes(sectionId)) throw new ExportError("That section hasn't been written yet.");
    order = [sectionId];
  }
  if (!order.length) throw new ExportError("There's nothing to export yet. Generate the packet first.");
  for (const sid of order) {
    if (typeof (sections[sid].markdown ?? "") !== "string") throw new ExportError("This packet's data is damaged, so it can't be exported.");
  }

  const title = clean(String(packet.title || "")).trim() || defaultTitle(options);
  const name = sectionId ? `${title} - ${sections[sectionId].name || sectionId}` : title;
  const filename = `${safeFilename(name)}.${format}`;
  const style = config.export_style || {};

  if (format === "md") {
    const text = sectionId
      ? `# ${sections[sectionId].name || sectionId}\n\n${String(sections[sectionId].markdown || "").trim()}\n`
      : toMarkdown({ ...packet, title }, Boolean(style.include_review_note));
    return { blob: new Blob([text], { type: "text/markdown;charset=utf-8" }), filename };
  }

  const doc = {
    title,
    info: infoLines(options).map(clean),
    sections: order.map((sid) => sectionBlocks(clean(sections[sid].name || sid), sections[sid].markdown || "")),
    wholePacket: !sectionId,
    style,
  };
  if (format === "docx") {
    const { toDocx } = await import("./export_docx.js?v=cbc5b6841e");
    return { blob: await toDocx(doc), filename };
  }
  if (format === "pdf") {
    const { toPdf } = await import("./export_pdf.js?v=cbc5b6841e");
    return { blob: await toPdf(doc), filename };
  }
  const { toPptx } = await import("./export_pptx.js?v=cbc5b6841e");
  return { blob: await toPptx(doc), filename };
}

// Parse a section. If Claude started it with its own title (e.g. "## Dividing Fractions: Lesson Plan"),
// use that as the section title instead of repeating it. Heading levels are then shifted so the
// biggest remaining heading is level 2.
function sectionBlocks(name, markdown) {
  let blocks = parse(markdown);
  if (blocks.length && blocks[0].type === "heading" && blocks[0].level <= 2) {
    const first = plain(blocks[0].runs).trim();
    if (first.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0])) {
      name = first;
      blocks = blocks.slice(1);
    }
  }
  const levels = blocks.filter((b) => b.type === "heading").map((b) => b.level);
  if (levels.length) {
    const shift = 2 - Math.min(...levels);
    for (const b of blocks) if (b.type === "heading") b.level = Math.min(b.level + shift, 4);
  }
  return [name, blocks];
}

function infoLines(o) {
  const lines = [`Grade: ${o.grade_level ?? ""}`, `Subject: ${o.subject ?? ""}`, `Topic: ${o.topic ?? ""}`,
                 `Schedule: ${o.num_days ?? ""} day(s) × ${o.class_minutes ?? ""} minutes`];
  if (o.teks?.length) lines.push(`TEKS: ${o.teks.join(", ")}`);
  if (o.standards) lines.push(`Standards: ${o.standards}`);
  return lines;
}

export function defaultTitle(options = {}) {
  return [options.topic, options.grade_level, options.subject].filter(Boolean).join(" – ") || "Untitled packet";
}

// The whole packet as one Markdown document (also what saved packets look like as text).
export function toMarkdown(packet, reviewNote = true) {
  const o = packet.options || {};
  const lines = [
    `# ${packet.title || defaultTitle(o)}`, "",
    `**Grade:** ${o.grade_level ?? ""}  `, `**Subject:** ${o.subject ?? ""}  `, `**Topic:** ${o.topic ?? ""}  `,
    `**Days:** ${o.num_days ?? ""} × ${o.class_minutes ?? ""} minutes  `,
  ];
  if (o.teks?.length) lines.push(`**TEKS:** ${o.teks.join(", ")}  `);
  if (o.standards) lines.push(`**Standards:** ${o.standards}  `);
  lines.push("");
  if (reviewNote) {
    lines.push("> **Review for accuracy.** This packet was written with AI help. "
      + "Check facts, answer keys, and standards before using it with students.", "");
  }
  for (const sid of packet.order || []) {
    const section = (packet.sections || {})[sid];
    if (!section) continue;
    lines.push("---", "", `# ${section.name || sid}`, "", String(section.markdown || "").trim(), "");
  }
  return lines.join("\n");
}

function safeFilename(name) {
  name = name.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  return name.slice(0, 120) || "Lesson packet";
}

// '1F3864' -> [31, 56, 100]
export function hexColor(value, fallback = "1F3864") {
  const hex = String(value || fallback).replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : hexColor(fallback);
}

// Relative column widths from how much text each column holds (short columns stay narrow).
export function columnWeights(header, rows) {
  const weights = header.map((_, col) => {
    const texts = [plain(header[col]), ...rows.map((r) => plain(r[col]))];
    const longestWord = Math.max(4, ...texts.flatMap((t) => t.split(/\s+/).map((w) => w.length)));
    const average = texts.reduce((sum, t) => sum + t.length, 0) / texts.length;
    return Math.max(average, longestWord * 1.2, 5) ** 0.75;
  });
  // Every column keeps a usable width, even next to a column holding paragraphs of text.
  const total = weights.reduce((a, b) => a + b, 0);
  const floor = total * Math.min(0.13, 0.6 / Math.max(weights.length, 1));
  return weights.map((w) => Math.max(w, floor));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
