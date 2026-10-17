// The web version's stand-in for the desktop app's local server (app/server.py).
// The interface (app.js, shared with the desktop app) calls api("/api/..."); on the web
// those calls come here instead and are answered inside the browser. Same checks and
// messages as server.py: keep them in step.

import { GenerationError, generate as claudeGenerate, testKey } from "./claude.js?v=a95f5dbc98";
import { ExportError, build as buildExport, defaultTitle, toMarkdown } from "./export.js?v=a95f5dbc98";
import { build as buildPrompt } from "./prompts.js?v=a95f5dbc98";
import { StorageError, db, keyStore } from "./store.js?v=a95f5dbc98";

// Packet ids become storage keys and file names, so only allow safe characters.
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{10,300}$/;
const ALLOWED_TYPES = [".txt", ".md"]; // .docx and .pdf: coming in a later web update

class UserError extends Error {}

let DEFAULTS = null; // prompts, sections, settings, TEKS/ELPS (data/*.json)

export async function loadDefaults() {
  const get = async (path) => {
    const response = await fetch(path, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Part of the app (${path}) couldn't be loaded. Reload the page.`);
    return response.json();
  };
  const [defaults, math, elps] = await Promise.all([
    get("data/defaults.json"), get("data/tx_math_6_8.json"), get("data/tx_elps_4_12.json")]);
  DEFAULTS = { ...defaults, standards: { math, elps } };
  return DEFAULTS;
}

const config = () => DEFAULTS.config;
const sections = () => [...DEFAULTS.sections].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

// ---- Routing ----

const ROUTES = [
  ["GET", /^\/api\/status$/, status],
  ["GET", /^\/api\/standards$/, () => ({ title: DEFAULTS.standards.math.title,
    source_version: DEFAULTS.standards.math.source_version || "", courses: DEFAULTS.standards.math.courses })],
  ["GET", /^\/api\/key$/, keyStatus],
  ["POST", /^\/api\/key$/, saveKey],
  ["DELETE", /^\/api\/key$/, () => { keyStore.remove(); return { saved: false }; }],
  ["POST", /^\/api\/seed\/read$/, readSeed],
  ["GET", /^\/api\/sections$/, () => ({ sections: sections() })],
  ["POST", /^\/api\/generate$/, generateSection],
  ["GET", /^\/api\/packets$/, listPackets],
  ["GET", /^\/api\/packets\/([^/]+)$/, (_, id) => loadPacket(id)],
  ["POST", /^\/api\/packets$/, savePacket],
  ["DELETE", /^\/api\/packets\/([^/]+)$/, (_, id) => deletePacket(id)],
  ["GET", /^\/api\/usage$/, usageSummary],
  ["POST", /^\/api\/export$/, exportPacket],
];

// Same contract as app.js's api(): returns the reply, or throws an Error with a readable message.
export async function handle(path, { method = "GET", json } = {}) {
  if (!DEFAULTS) await loadDefaults();
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const match = routeMethod === method && path.match(pattern);
    if (match) {
      try {
        return await handler(json ?? {}, ...match.slice(1).map(decodeURIComponent));
      } catch (e) {
        if (e instanceof UserError || e instanceof GenerationError || e instanceof ExportError || e instanceof StorageError) throw e;
        if (e.name === "AbortError") throw e;
        throw new Error(`Something unexpected went wrong (${e.name}: ${e.message}). Please try again; `
          + "if it keeps happening, reload the page.");
      }
    }
  }
  throw new Error("That isn't available in the web version.");
}

// ---- Status ----

function status() {
  return {
    settings_problem: "",
    version: DEFAULTS.version,
    mock: false,
    model: config().model,
    data_dir: "This browser, on this computer",
    max_upload_mb: config().max_upload_mb,
    max_seed_characters: config().max_seed_characters,
    allowed_types: ALLOWED_TYPES,
    prompts_outdated: [],
    platform: "web",
    export_formats: ["docx", "md"], // PDF and PowerPoint: coming in a later web update
  };
}

// ---- API key ----

const mask = (key) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…");

function keyStatus() {
  const key = keyStore.get();
  return { saved: Boolean(key), masked: key ? mask(key) : "", remembered: keyStore.remembered() };
}

async function saveKey(body) {
  const key = String(body.key || "").trim();
  if (!key.startsWith("sk-ant-")) throw new UserError("That doesn't look like a Claude API key. Keys start with “sk-ant-”.");
  if (!KEY_PATTERN.test(key)) {
    throw new UserError("That key looks incomplete or has extra characters in it. Copy it again from platform.claude.com.");
  }
  const warning = await testKey(key, config()); // throws a readable error if the key is bad
  keyStore.save(key, Boolean(body.remember));
  return { saved: true, masked: mask(key), warning,
           where: body.remember ? "this browser on this computer" : "this tab only, until you close it" };
}

// ---- Lesson outline from a file ----

function readSeed(body) {
  const name = String(body.filename || "");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (ext === ".docx" || ext === ".pdf") {
    throw new UserError(`Reading ${ext} files is coming soon to the web version. For now, open “${name}”, `
      + "copy the text, and paste it into the box.");
  }
  if (!ALLOWED_TYPES.includes(ext)) {
    throw new UserError(`“${name}” isn't a supported file type. Use .txt or .md, or copy the text and paste it in.`);
  }
  const maxMb = config().max_upload_mb || 10;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(body.data_base64 || ""), (c) => c.charCodeAt(0));
  } catch {
    throw new UserError("The file didn't arrive intact. Please try again.");
  }
  if (bytes.length > maxMb * 1024 * 1024) throw new UserError(`“${name}” is larger than ${maxMb} MB.`);
  const text = tidy(decodeText(bytes));
  if (!text) throw new UserError(`No text was found in “${name}”.`);
  return { text, words: text.split(/\s+/).filter(Boolean).length, characters: text.length };
}

function decodeText(bytes) {
  // UTF-16 files start with a marker (some Windows tools save text this way).
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    try { return new TextDecoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be", { fatal: true }).decode(bytes); } catch { /* next */ }
  }
  // Most files are UTF-8; older Windows/Mac text files may use other encodings.
  for (const encoding of ["utf-8", "windows-1252", "macintosh"]) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { /* next */ }
  }
  throw new UserError("This text file uses an unusual character encoding. Try pasting the text instead.");
}

// Strip trailing spaces and squeeze runs of blank lines (same as the desktop app).
function tidy(text) {
  text = text.replace(/[\x0b\x0c]/g, "\n").replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
  const tidyLines = [];
  for (const line of text.split(/\r\n|\r|\n/).map((l) => l.trimEnd())) {
    if (line || (tidyLines.length && tidyLines[tidyLines.length - 1])) tidyLines.push(line);
  }
  return tidyLines.join("\n").trim();
}

// ---- Writing a section ----

function checkOptions(o) {
  if (!o || typeof o !== "object") throw new UserError("Please check “options”: the form didn't arrive.");
  for (const [field, label] of [["seed", "your lesson outline"], ["grade_level", "grade level"], ["subject", "subject"], ["topic", "topic"]]) {
    if (typeof o[field] !== "string" || !o[field].trim()) throw new UserError(`Please fill in: ${label}.`);
  }
  const whole = (value, low, high, label) => {
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new UserError(`Please check “${label}”: it should be a whole number from ${low} to ${high}.`);
    }
  };
  whole(o.num_days, 1, 20, "num days");
  whole(o.class_minutes, 10, 240, "class minutes");
  if (!Array.isArray(o.teks) || o.teks.length > 40) throw new UserError("Please check “teks”: choose at most 40.");
  const limit = config().max_seed_characters || 60000;
  if (o.seed.length > limit) throw new UserError(`Your lesson outline is longer than ${limit.toLocaleString()} characters.`);
}

async function generateSection(body) {
  const options = {
    standards: "", teks: [], elps: false, spanish: false, notes: "", ...body.options,
  };
  checkOptions(options);
  const section = sections().find((s) => s.id === body.section_id);
  if (!section) throw new UserError(`Unknown section “${body.section_id}”.`);
  const currentText = String(body.current_text || "").trim();
  const extra = String(body.extra_instructions || "");
  if (currentText && !extra.trim()) throw new UserError("Type what you'd like changed, then click Revise.");

  const { system, user } = buildPrompt({
    section, options, lessonPlan: String(body.lesson_plan || ""), extraInstructions: extra,
    currentText, followText: String(body.follow_text || ""), prompts: DEFAULTS.prompts, standards: DEFAULTS.standards,
  });
  const result = await claudeGenerate({ apiKey: keyStore.get(), system, user, config: config() });
  await recordUsage(result.model, section.id + (currentText ? " (revise)" : ""), result.usage, result.cost);
  return { section_id: section.id, name: section.name, ...result };
}

// ---- Saved packets ----

const pad = (n) => String(n).padStart(2, "0");
const localIso = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function newId(title) {
  const d = new Date();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "packet";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${slug}`;
}

function checkId(id) {
  if (!SAFE_ID.test(id || "")) throw new UserError("That packet name isn't valid.");
  return id;
}

async function listPackets() {
  const all = await db.all("packets");
  const summaries = all.filter((p) => p && typeof p === "object").map((p) => {
    const options = p.options && typeof p.options === "object" ? p.options : {};
    return {
      id: p.id, title: p.title || p.id, saved_at: String(p.saved_at || ""),
      grade_level: options.grade_level || "", subject: options.subject || "",
      sections: Object.keys(p.sections || {}).length,
    };
  });
  return { packets: summaries.sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1)) };
}

async function loadPacket(id) {
  const packet = await db.get("packets", checkId(id));
  if (!packet) throw new UserError("That packet no longer exists. It may have been deleted.");
  return packet;
}

export async function savePacket(input) {
  if (!input || typeof input.sections !== "object" || Array.isArray(input.sections)
      || typeof input.options !== "object" || Array.isArray(input.options)) {
    throw new UserError("There's no packet to save yet.");
  }
  const packet = structuredClone(input);
  packet.title = String(packet.title || "").trim() || defaultTitle(packet.options);
  packet.id = checkId(packet.id || newId(packet.title));
  packet.saved_at = localIso();
  packet.app_version = DEFAULTS.version;
  await db.put("packets", packet);
  return { id: packet.id, title: packet.title, saved_at: packet.saved_at };
}

async function deletePacket(id) {
  await db.delete("packets", checkId(id));
  return { deleted: id };
}

// Backups: every saved packet in one file (the same packet format as the desktop app).
export async function backupFile() {
  const packets = await db.all("packets");
  const backup = { app: "Lesson Packet Builder", kind: "packets backup", version: DEFAULTS.version,
                   exported_at: localIso(), packets };
  return { blob: new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" }),
           filename: `Lesson packets backup ${localIso().slice(0, 10)}.json`, count: packets.length };
}

// Accepts a backup file, or one packet saved by the desktop app (.json in its packets folder).
// A packet already here is only replaced by a newer copy. Returns {added, updated, skipped}.
export async function restoreBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError("That file isn't a Lesson Packet Builder backup (it couldn't be read).");
  }
  const list = Array.isArray(data?.packets) ? data.packets : data?.sections ? [data] : null;
  if (!list) throw new UserError("That file isn't a Lesson Packet Builder backup or saved packet.");
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const p of list) {
    const valid = p && typeof p === "object" && p.sections && typeof p.sections === "object" && !Array.isArray(p.sections)
      && p.options && typeof p.options === "object" && Array.isArray(p.order);
    if (!valid) { counts.skipped++; continue; }
    if (!SAFE_ID.test(p.id || "")) p.id = newId(String(p.title || "packet"));
    const existing = await db.get("packets", p.id);
    if (existing && String(existing.saved_at || "") >= String(p.saved_at || "")) { counts.skipped++; continue; }
    await db.put("packets", p);
    counts[existing ? "updated" : "added"]++;
  }
  return counts;
}

// ---- Usage (token counts and costs only, never packet content) ----

async function recordUsage(model, sectionId, usage, cost) {
  try {
    await db.add("usage", { time: localIso(), model, section: sectionId, ...usage, estimated_cost_usd: cost });
  } catch { /* the section matters more than the log */ }
}

async function usageSummary() {
  const months = {};
  const byModel = {};
  const thisMonth = localIso().slice(0, 7);
  for (const row of await db.all("usage")) {
    const month = String(row.time || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const m = months[month] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0, unpriced_calls: 0 };
    m.calls++;
    m.input_tokens += (row.input_tokens || 0) + (row.cache_write_tokens || 0) + (row.cache_read_tokens || 0);
    m.output_tokens += row.output_tokens || 0;
    if (typeof row.estimated_cost_usd === "number") m.cost += row.estimated_cost_usd; else m.unpriced_calls++;
    if (month === thisMonth) {
      const b = byModel[row.model] ??= { calls: 0, cost: 0 };
      b.calls++;
      b.cost += row.estimated_cost_usd || 0;
    }
  }
  const history = Object.entries(months).sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, v]) => ({ month, ...v, cost: Math.round(v.cost * 100) / 100 }));
  return {
    this_month: history.find((h) => h.month === thisMonth)
      || { month: thisMonth, calls: 0, input_tokens: 0, output_tokens: 0, cost: 0, unpriced_calls: 0 },
    by_model: Object.entries(byModel).map(([model, v]) => ({ model, calls: v.calls, cost: Math.round(v.cost * 100) / 100 })),
    history,
    log_file: "",
  };
}

// ---- Export: build the file and hand it to the browser as a download ----

async function exportPacket(body) {
  const { blob, filename } = await buildExport(body.packet, body.section_id || null, body.format, config());
  download(blob, filename);
  return { downloaded: true, name: filename };
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export { toMarkdown };
