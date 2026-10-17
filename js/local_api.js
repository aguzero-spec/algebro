// The web version's stand-in for the desktop app's local server (app/server.py).
// The interface (app.js, shared with the desktop app) calls api("/api/..."); on the web
// those calls come here instead and are answered inside the browser. Same checks and
// messages as server.py: keep them in step.

import { GenerationError, generate as claudeGenerate, testKey } from "./claude.js?v=c70461b0d2";
import { ExportError, build as buildExport, defaultTitle, toMarkdown } from "./export.js?v=c70461b0d2";
import { build as buildPrompt } from "./prompts.js?v=c70461b0d2";
import { StorageError, db, keyStore } from "./store.js?v=c70461b0d2";
import { loadScript } from "./vendor.js?v=c70461b0d2";

// Packet ids become storage keys and file names, so only allow safe characters.
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{10,300}$/;
const ALLOWED_TYPES = [".docx", ".pdf", ".txt", ".md"];

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
  DEFAULT_HASHES = Object.fromEntries(await Promise.all(
    Object.entries(DEFAULTS.prompts).map(async ([name, text]) => [name, await sha256(text)])));
  await loadOverrides();
  return DEFAULTS;
}

// ---- The teacher's own settings (Settings page), kept in this browser ----
// Like the desktop app's data folder: edited prompts are never replaced by an update;
// new default sections are added unless the teacher removed them on purpose.

let DEFAULT_HASHES = {};
const OVERRIDES = { config: {}, prompts: {}, sections: null };
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const EDITABLE_STYLE = ["include_review_note", "new_page_per_section"];

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadOverrides() {
  try {
    OVERRIDES.config = (await db.get("settings", "config")) || {};
    OVERRIDES.prompts = (await db.get("settings", "prompts")) || {};
    OVERRIDES.sections = (await db.get("settings", "sections")) || null;
    if (OVERRIDES.sections) {
      const seen = new Set((await db.get("settings", "sections_seen")) || OVERRIDES.sections.map((s) => s.id));
      const have = new Set(OVERRIDES.sections.map((s) => s.id));
      const added = DEFAULTS.sections.filter((s) => !seen.has(s.id) && !have.has(s.id));
      if (added.length) {
        OVERRIDES.sections.push(...added.map((s) => ({ ...s, order: 900 + (s.order ?? 0) })));
        await db.put("settings", OVERRIDES.sections, "sections");
      }
      await db.put("settings", [...new Set([...seen, ...DEFAULTS.sections.map((s) => s.id)])], "sections_seen");
    }
  } catch {
    // Storage blocked (e.g. private browsing): use the defaults; saving will explain the problem.
  }
}

function config() {
  const c = { ...DEFAULTS.config, ...OVERRIDES.config };
  c.export_style = { ...DEFAULTS.config.export_style, ...(OVERRIDES.config.export_style || {}) };
  return c;
}

const sections = () => [...(OVERRIDES.sections || DEFAULTS.sections)].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

const prompts = () => ({ ...DEFAULTS.prompts,
  ...Object.fromEntries(Object.entries(OVERRIDES.prompts).map(([name, p]) => [name, p.text])) });

// Edited prompts whose default has changed since the teacher's copy was made.
const outdatedPrompts = () => Object.entries(OVERRIDES.prompts)
  .filter(([name, p]) => DEFAULT_HASHES[name] && p.base !== DEFAULT_HASHES[name]).map(([name]) => name);

function webSettings() {
  const c = config();
  return {
    config: { model: c.model, effort: c.effort || "", max_output_tokens: c.max_output_tokens,
              ...Object.fromEntries(EDITABLE_STYLE.map((k) => [k, Boolean(c.export_style[k])])) },
    models: [...new Set([c.model, ...Object.keys(c.prices || {})])],
    efforts: EFFORT_LEVELS,
    sections: sections(),
    prompts: Object.keys(prompts()).sort().map((name) => ({
      name, text: prompts()[name], edited: name in OVERRIDES.prompts, custom: !(name in DEFAULTS.prompts),
      outdated: outdatedPrompts().includes(name), used_by: sections().filter((s) => s.prompt_file === name).map((s) => s.name),
    })),
  };
}

async function saveConfig(body) {
  const model = String(body.model || "").trim();
  if (!/^[\w.-]{3,80}$/.test(model)) throw new UserError("Choose a model.");
  if (body.effort && !EFFORT_LEVELS.includes(body.effort)) throw new UserError("Choose an effort level.");
  const max = Number(body.max_output_tokens);
  if (!Number.isInteger(max) || max < 1000 || max > 128000) {
    throw new UserError("The length limit should be a whole number from 1,000 to 128,000.");
  }
  const next = { model, effort: body.effort || null, max_output_tokens: max,
                 export_style: Object.fromEntries(EDITABLE_STYLE.map((k) => [k, Boolean(body[k])])) };
  await db.put("settings", next, "config");
  OVERRIDES.config = next;
  return webSettings();
}

async function savePrompt(body) {
  const name = String(body.name || "");
  if (!(name in prompts())) throw new UserError("That prompt doesn't exist.");
  const text = String(body.text ?? "");
  if (!text.trim()) throw new UserError("A prompt can't be empty. To undo your changes, use “Restore the default”.");
  if (text.length > 100000) throw new UserError("That prompt is too long (over 100,000 characters).");
  const next = { ...OVERRIDES.prompts };
  if (DEFAULTS.prompts[name] === text) delete next[name]; // identical to the default: just use the default
  else next[name] = { text, base: OVERRIDES.prompts[name]?.base ?? DEFAULT_HASHES[name] ?? null };
  await db.put("settings", next, "prompts");
  OVERRIDES.prompts = next;
  return webSettings();
}

async function restorePrompt(body) {
  const name = String(body.name || "");
  if (!(name in DEFAULTS.prompts)) throw new UserError("Only the built-in prompts have a default to restore.");
  const next = { ...OVERRIDES.prompts };
  delete next[name];
  await db.put("settings", next, "prompts");
  OVERRIDES.prompts = next;
  return webSettings();
}

const SECTION_ID = /^[a-z][a-z0-9_]{0,40}$/;

async function saveSections(body) {
  const list = body.sections;
  if (!Array.isArray(list) || !list.length) throw new UserError("Keep at least one section.");
  if (list.length > 30) throw new UserError("That's too many sections (at most 30).");
  const ids = new Set();
  const nextPrompts = { ...OVERRIDES.prompts };
  const clean = list.map((s, n) => {
    const name = String(s.name || "").trim();
    if (!name) throw new UserError(`Section ${n + 1} needs a name.`);
    const id = String(s.id || "");
    if (!SECTION_ID.test(id) || ids.has(id)) throw new UserError(`Section “${name}” has an invalid or repeated id.`);
    ids.add(id);
    const promptFile = String(s.prompt_file || `${id}.txt`);
    if (!/^[a-z0-9_]+\.txt$/.test(promptFile)) throw new UserError(`Section “${name}” has an invalid prompt file.`);
    if (!(promptFile in prompts()) && !(promptFile in nextPrompts)) {
      // A new section: start its prompt from a simple template the teacher can edit.
      nextPrompts[promptFile] = { text: `Write the “${name}” section for this lesson plan:\n\n<lesson_plan>\n{{lesson_plan}}\n</lesson_plan>\n\n`
        + "Describe here what this section should contain, how long it should be, and how to format it.\n", base: null };
    }
    const clean = { id, name: name.slice(0, 80), prompt_file: promptFile, on_by_default: Boolean(s.on_by_default), order: n + 1 };
    if (s.follows && typeof s.follows === "string") clean.follows = s.follows;
    return clean;
  });
  await db.put("settings", nextPrompts, "prompts");
  await db.put("settings", clean, "sections");
  await db.put("settings", [...new Set([...clean.map((s) => s.id), ...DEFAULTS.sections.map((s) => s.id)])], "sections_seen");
  OVERRIDES.prompts = nextPrompts;
  OVERRIDES.sections = clean;
  return webSettings();
}

async function resetAll() {
  await db.put("settings", {}, "prompts");
  await db.put("settings", null, "sections");
  OVERRIDES.prompts = {};
  OVERRIDES.sections = null;
  return webSettings();
}

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
  // Web only: the Settings page editors (the desktop app uses files in its data folder instead).
  ["GET", /^\/api\/web\/settings$/, webSettings],
  ["POST", /^\/api\/web\/config$/, saveConfig],
  ["POST", /^\/api\/web\/prompt$/, savePrompt],
  ["POST", /^\/api\/web\/prompt\/restore$/, restorePrompt],
  ["POST", /^\/api\/web\/sections$/, saveSections],
  ["POST", /^\/api\/web\/reset$/, resetAll],
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
    prompts_outdated: outdatedPrompts(),
    platform: "web",
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

async function readSeed(body) {
  const name = String(body.filename || "");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_TYPES.includes(ext)) {
    throw new UserError(`“${name}” isn't a supported file type. Use .docx, .pdf, .txt, or .md `
      + "(for other formats, copy the text and paste it in).");
  }
  const maxMb = config().max_upload_mb || 10;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(body.data_base64 || ""), (c) => c.charCodeAt(0));
  } catch {
    throw new UserError("The file didn't arrive intact. Please try again.");
  }
  if (bytes.length > maxMb * 1024 * 1024) throw new UserError(`“${name}” is larger than ${maxMb} MB.`);
  const limit = config().max_seed_characters || 60000;
  let raw;
  try {
    raw = ext === ".docx" ? await readDocx(bytes) : ext === ".pdf" ? await readPdf(bytes, limit) : decodeText(bytes);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`Couldn't read “${name}”. It may be damaged or not really a ${ext} file. `
      + "Try opening it and pasting the text instead.");
  }
  const text = raw.length > limit * 3 ? raw : tidy(raw); // (no need to tidy a file that's far too long)
  if (text.length > limit) { // more than an outline can use (and a huge text box would slow the page down)
    throw new UserError(`“${name}” has more text than a lesson outline can hold (over ${limit.toLocaleString()} characters). `
      + "Open it, copy the part for this lesson, and paste it into the box.");
  }
  if (!text) {
    throw new UserError(`No text was found in “${name}”.`
      + (ext === ".pdf" ? " It may be a scanned image; copy and paste the text instead." : ""));
  }
  return { text, words: text.split(/\s+/).filter(Boolean).length, characters: text.length };
}

// A .docx is a zip archive. Its directory lists how big each part becomes when unpacked:
// refuse files that would unpack to something huge (a "zip bomb" can crash the browser tab).
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024;

function unpackedSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; } // end-of-directory record
  }
  if (end < 0) throw new Error("not a zip file");
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return Infinity; // only enormous archives use this marker
    total += size;
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
}

// Word: the text of every paragraph (and table cell), in order.
async function readDocx(bytes) {
  if (unpackedSize(bytes) > MAX_UNPACKED_BYTES) {
    throw new UserError("This Word file is unusually large inside (over 150 MB of text and pictures), so it wasn't opened. "
      + "Copy the text you need and paste it in instead.");
  }
  const mammoth = await loadScript("vendor/mammoth-1.13.0/mammoth.browser.min.js", "mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
  return result.value;
}

// PDF: the text of every page, read by pdf.js in a background worker.
// Stops once there's clearly more text than an outline can use.
async function readPdf(bytes, limit) {
  const pdfjs = await import("../vendor/pdfjs-6.4.299/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs-6.4.299/pdf.worker.min.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true });
  // A damaged or booby-trapped PDF can keep the reader busy for minutes: give up after 45 seconds.
  const timer = setTimeout(() => task.destroy(), 45_000);
  try {
    return await readPdfPages(task, limit);
  } catch (e) {
    if (task.destroyed) {
      throw new UserError("This PDF is taking too long to read. Open it, copy the text, and paste it in.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readPdfPages(task, limit) {
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (e?.name === "PasswordException") {
      throw new UserError("This PDF is password-protected. Open it, copy the text, and paste it in.");
    }
    throw e;
  }
  const pages = [];
  let total = 0;
  for (let n = 1; n <= pdf.numPages && total <= limit * 2; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
    pages.push(text);
    total += text.length;
  }
  await task.destroy(); // closes the file and its background worker
  return pages.join("\n\n");
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
    currentText, followText: String(body.follow_text || ""), prompts: prompts(), standards: DEFAULTS.standards,
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

// A packet from a file, reduced to what the app uses (files can be damaged or hand-edited).
// Returns null if it isn't a usable packet.
const SECTION_KEY = /^[A-Za-z0-9_-]{1,60}$/;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanPacket(p) {
  if (!isPlainObject(p) || !isPlainObject(p.sections) || !isPlainObject(p.options) || !Array.isArray(p.order)) return null;
  const sections = {};
  for (const [id, s] of Object.entries(p.sections)) {
    if (!SECTION_KEY.test(id) || !isPlainObject(s)) continue;
    sections[id] = { ...s, name: String(s.name ?? id), markdown: String(s.markdown ?? "") };
  }
  const order = [...new Set(p.order.filter((id) => typeof id === "string" && Object.hasOwn(sections, id)))];
  if (!order.length) return null; // nothing in it
  const instructions = isPlainObject(p.instructions)
    ? Object.fromEntries(Object.entries(p.instructions).filter(([id, v]) => Object.hasOwn(sections, id) && typeof v === "string"))
    : {};
  return { ...p, sections, order, instructions, title: String(p.title ?? ""), saved_at: String(p.saved_at ?? "") };
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
  for (const raw of list) {
    const p = cleanPacket(raw);
    if (!p) { counts.skipped++; continue; }
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
