// PDF export, built with the bundled pdfmake library and the Arimo font (vendor/).
// The browser version of app/export_pdf.py: same layout. Arimo looks and measures like Arial,
// which can't be put on a website; Word and PowerPoint files still use Arial.

import { REVIEW_NOTE, columnWeights, hexColor } from "./export.js?v=cfb25fa99c";
import { loadScript } from "./vendor.js?v=cfb25fa99c";

const FONT_FOLDER = "vendor/arimo-4a6255f";
const FONT_FILES = { normal: "Arimo-Regular.ttf", bold: "Arimo-Bold.ttf",
                     italics: "Arimo-Italic.ttf", bolditalics: "Arimo-BoldItalic.ttf" };
const LINE = 1.2;          // line height as a multiple of the font size
const PAGE_WIDTH_PT = 612; // US Letter

let ready = null;

// Load pdfmake and hand it the Arimo font files (once).
function loadPdfmake() {
  ready ??= (async () => {
    const pdfMake = await loadScript("vendor/pdfmake-0.3.11/pdfmake.min.js", "pdfMake");
    const vfs = {};
    await Promise.all(Object.values(FONT_FILES).map(async (file) => {
      const response = await fetch(`${FONT_FOLDER}/${file}`);
      if (!response.ok) throw new Error("The PDF font couldn't be loaded. Check your internet connection and try again.");
      vfs[file] = toBase64(new Uint8Array(await response.arrayBuffer()));
    }));
    pdfMake.addVirtualFileSystem(vfs);
    pdfMake.addFonts({ Arimo: FONT_FILES });
    return pdfMake;
  })();
  ready.catch(() => { ready = null; }); // allow a retry
  return ready;
}

function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const css = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

export async function toPdf(doc) {
  const pdfMake = await loadPdfmake();
  const style = doc.style;
  const size = Number(style.body_size_pt || 11);
  const margin = Number(style.margins_inches || 1) * 72;
  const ctx = {
    size,
    width: PAGE_WIDTH_PT - 2 * margin,
    heading: css(hexColor(style.heading_color)),
    fill: css(hexColor(style.table_header_color, "D9E2F3")),
  };
  const content = [];

  content.push(headingNode([{ text: doc.title }], Number(style.title_size_pt || 22), ctx));
  if (doc.wholePacket) {
    for (const line of doc.info) {
      const at = line.indexOf(": ");
      const [label, value] = at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 2)];
      content.push({ text: [{ text: `${label}: `, bold: true }, value], margin: [0, 0, 0, 1] });
    }
    content.push({ text: "", margin: [0, 0, 0, 10] });
    if (style.include_review_note) {
      content.push({ table: { widths: ["*"], body: [[{ text: REVIEW_NOTE, italics: true, fillColor: "#FFF6DB", margin: [6, 6, 6, 6] }]] },
                     layout: "noBorders", margin: [0, 0, 0, 6] });
    }
  }

  doc.sections.forEach(([title, blocks], n) => {
    const heading = headingNode([{ text: title }], size + 7, ctx);
    // The first section follows the cover on page 1; later ones start new pages.
    if (n && doc.wholePacket && (style.new_page_per_section ?? true)) heading.pageBreak = "before";
    content.push(heading);
    for (const block of blocks) content.push(blockNode(block, ctx));
  });

  const definition = {
    pageSize: "LETTER",
    pageMargins: [margin, margin, margin, margin],
    info: { title: doc.title, creator: "Lesson Packet Builder" },
    defaultStyle: { font: "Arimo", fontSize: size, lineHeight: LINE },
    footer: (page) => ({ text: `Page ${page}`, alignment: "center", fontSize: 9, color: "#787878", margin: [0, margin * 0.4, 0, 0] }),
    // Don't strand a heading at the bottom of a page.
    pageBreakBefore: (node, following) => Boolean(node.headlineLevel) && following.length === 0,
    content,
  };
  return pdfMake.createPdf(definition).getBlob();
}

function headingNode(runs, fontSize, ctx) {
  return { text: textRuns(runs), fontSize, bold: true, color: ctx.heading, headlineLevel: 1,
           margin: [0, fontSize * 0.5, 0, fontSize * 0.3] };
}

function blockNode(b, ctx) {
  const { size } = ctx;
  switch (b.type) {
    case "heading":
      return headingNode(b.runs, { 2: size + 4, 3: size + 2 }[b.level] ?? size + 1, ctx);
    case "paragraph":
      return { text: textRuns(b.runs), margin: [0, 0, 0, size * 0.4] };
    case "list_item": {
      const indent = 14 + 18 * b.level;
      const marker = b.ordered ? `${b.number}.` : b.level === 0 ? "•" : "◦";
      // Wrapped lines line up with the text, not the bullet.
      return { columns: [{ width: indent, text: marker, alignment: "right" }, { width: "*", text: textRuns(b.runs) }],
               columnGap: 5, margin: [0, 0, 0, 2] };
    }
    case "quote":
      return { table: { widths: ["*"], body: [[{ text: textRuns(b.runs), color: "#464646" }]] },
               layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 2 : 0), vLineColor: () => "#AAAAAA",
                         paddingLeft: () => 11, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
               margin: [3, 4, 0, 8] };
    case "rule":
      return { canvas: [{ type: "line", x1: 0, y1: 0, x2: ctx.width, y2: 0, lineWidth: 0.5, lineColor: "#BEBEBE" }],
               margin: [0, 4, 0, 8] };
    case "table":
      return tableNode(b, ctx);
    default:
      return { text: "" };
  }
}

function tableNode(b, { size, width, fill }) {
  const weights = columnWeights(b.header, b.rows);
  const total = weights.reduce((a, c) => a + c, 0);
  const padding = 8; // pdfmake widths exclude cell padding
  const widths = weights.map((w) => Math.max((width * w) / total - padding, 10));
  const body = [b.header, ...b.rows].map((cells, r) => cells.map((runs) => ({
    text: textRuns(runs), bold: r === 0, fillColor: r === 0 ? fill : undefined,
  })));
  return {
    table: { headerRows: 1, widths, body }, // the header row repeats on each page; tall rows split across pages
    fontSize: size - 1,
    layout: { hLineColor: () => "#A0A0A0", vLineColor: () => "#A0A0A0", hLineWidth: () => 0.5, vLineWidth: () => 0.5,
              paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 2, 0, size * 0.6],
  };
}

// Emoji aren't in the font; leave them out (as the desktop app does) rather than print empty boxes.
// (Only true emoji: symbols like © ™ ≤ ÷ √ stay.)
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F}|[\u{FE0F}\u{200D}]/gu;

function textRuns(runs) {
  return runs.map((r) => (r.text === "\n" ? "\n" : {
    text: r.text.replaceAll("\t", "    ").replace(EMOJI, ""), bold: Boolean(r.bold) || undefined, italics: Boolean(r.italic) || undefined,
  }));
}
