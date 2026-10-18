// Word (.docx) export. Real Word headings, lists, and tables, so the file stays fully editable.
// The browser version of app/export_docx.py, built with the bundled "docx" library (vendor/).

import { REVIEW_NOTE, columnWeights } from "./export.js?v=cbc5b6841e";
import { loadScript } from "./vendor.js?v=cbc5b6841e";

const PAGE_WIDTH_INCHES = 8.5;
const TWIPS_PER_INCH = 1440;
const twips = (inches) => Math.round(inches * TWIPS_PER_INCH);
const halfPoints = (points) => Math.round(points * 2);

export async function toDocx(doc) {
  const d = await loadScript("vendor/docx-9.8.1/docx.iife.js", "docx");
  const style = doc.style;
  const font = style.font || "Arial";
  const size = Number(style.body_size_pt || 11);
  const color = String(style.heading_color || "1F3864").replace(/^#/, "");
  const margins = Number(style.margins_inches || 1);
  const width = PAGE_WIDTH_INCHES - 2 * margins;
  const ctx = { d, font, size, width, fill: String(style.table_header_color || "D9E2F3").replace(/^#/, "") };

  const heading = (pts) => ({ run: { font, size: halfPoints(pts), color, bold: true },
                              paragraph: { spacing: { before: 240, after: 80 } } });
  const children = [];

  // Cover: title, class info, and (for whole packets) the review reminder.
  children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, spacing: { after: 240 },
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 8, color: "4F81BD", space: 4 } }, // like Word's Title style
    children: [new d.TextRun(doc.title)] }));
  if (doc.wholePacket) {
    for (const line of doc.info) {
      const at = line.indexOf(": ");
      const [label, value] = at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 2)];
      children.push(new d.Paragraph({ spacing: { after: 0 },
        children: [new d.TextRun({ text: `${label}: `, bold: true, font }), new d.TextRun({ text: value, font })] }));
    }
    if (style.include_review_note) {
      children.push(new d.Paragraph({ spacing: { before: 240 }, shading: { type: d.ShadingType.CLEAR, fill: "FFF6DB", color: "auto" },
        children: [new d.TextRun({ text: REVIEW_NOTE, italics: true, font })] }));
    }
  }

  doc.sections.forEach(([title, blocks], n) => {
    // The first section follows the cover on page 1; later ones start new pages.
    children.push(new d.Paragraph({
      heading: d.HeadingLevel.HEADING_1, children: [new d.TextRun(title)],
      pageBreakBefore: Boolean(n && doc.wholePacket && (style.new_page_per_section ?? true)),
    }));
    for (const block of blocks) children.push(...addBlock(block, ctx));
  });

  const document = new d.Document({
    creator: "Lesson Packet Builder",
    title: doc.title,
    styles: {
      default: {
        document: { run: { font, size: halfPoints(size) }, paragraph: { spacing: { after: 80 } } },
        title: { run: { font, size: halfPoints(Number(style.title_size_pt || 22)), color } },
        heading1: heading(size + 7), heading2: heading(size + 4),
        heading3: heading(size + 2), heading4: heading(size + 1),
      },
    },
    sections: [{
      properties: { page: { margin: { top: twips(margins), bottom: twips(margins), left: twips(margins), right: twips(margins) } } },
      footers: { default: new d.Footer({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER,
        children: [new d.TextRun({ text: "Page ", font }), new d.TextRun({ children: [d.PageNumber.CURRENT], font })] })] }) },
      children,
    }],
  });
  return d.Packer.toBlob(document);
}

const HEADINGS = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];

function addBlock(block, ctx) {
  const { d } = ctx;
  switch (block.type) {
    case "heading":
      return [new d.Paragraph({ heading: d.HeadingLevel[HEADINGS[block.level - 1]], children: runs(block.runs, ctx) })];
    case "paragraph":
      return [new d.Paragraph({ children: runs(block.runs, ctx) })];
    case "list_item":
      return [listItem(block, ctx)];
    case "quote":
      return [new d.Paragraph({ indent: { left: twips(0.3) },
        border: { left: { style: d.BorderStyle.SINGLE, size: 18, color: "A6A6A6", space: 8 } },
        children: runs(block.runs, ctx) })];
    case "rule":
      return [new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 8 } } })];
    case "table":
      return [table(block, ctx), new d.Paragraph({ spacing: { after: 40 } })];
    default:
      return [];
  }
}

function listItem(block, ctx) {
  const { d } = ctx;
  const level = Math.min(block.level, 2);
  if (block.ordered) {
    // Numbers are written out ("1.") rather than using Word's auto-numbering,
    // which would keep counting across separate lists in the document.
    return new d.Paragraph({ spacing: { after: 40 },
      indent: { left: twips(0.3 + 0.3 * level), hanging: twips(0.22) },
      children: [new d.TextRun({ text: `${block.number}. `, font: ctx.font }), ...runs(block.runs, ctx)] });
  }
  return new d.Paragraph({ bullet: { level }, spacing: { after: 40 }, children: runs(block.runs, ctx) });
}

function table(block, ctx) {
  const { d, size, width, fill } = ctx;
  const weights = columnWeights(block.header, block.rows);
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => twips((width * w) / total));
  const border = { style: d.BorderStyle.SINGLE, size: 4, color: "A0A0A0" };
  const rows = [block.header, ...block.rows].map((cells, r) => new d.TableRow({
    tableHeader: r === 0, // repeat the header row at the top of each printed page
    children: cells.map((cellRuns, c) => new d.TableCell({
      width: { size: widths[c], type: d.WidthType.DXA },
      shading: r === 0 ? { type: d.ShadingType.CLEAR, fill, color: "auto" } : undefined,
      children: [new d.Paragraph({ spacing: { after: 0 }, children: runs(cellRuns, ctx, size - 1, r === 0) })],
    })),
  }));
  return new d.Table({
    rows,
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: d.WidthType.DXA },
    layout: d.TableLayoutType.FIXED,
    // Explicit borders, so Pages and Google Docs show them too.
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
  });
}

function runs(list, ctx, size = null, bold = false) {
  const { d } = ctx;
  return list.map((r) => {
    if (r.text === "\n") return new d.TextRun({ break: 1 });
    return new d.TextRun({
      text: r.text,
      bold: Boolean(r.bold || bold) || undefined,
      italics: r.italic || undefined,
      // Named on every piece of text (not only as the document default), so Pages, Google Docs,
      // and Mac previews show the same font as Word.
      font: r.code ? "Courier New" : ctx.font,
      size: size ? halfPoints(size) : undefined,
    });
  });
}
