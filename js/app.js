// Lesson Packet Builder - interface logic. Plain JavaScript, no build step.

// ---------- Token + API helper ----------

// The launcher opens the window at  .../#token=XYZ . Keep the token for this
// window session, then remove it from the address bar.
const TOKEN = (() => {
  const match = location.hash.match(/token=([^&]+)/);
  if (match) {
    sessionStorage.setItem("token", match[1]);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("token") || "";
})();

// Call the local server. Returns parsed JSON or throws an Error with a readable message.
// The web version has no server: there, web/js/local_api.js answers the same calls in the browser.
async function api(path, { method = "GET", json, form } = {}) {
  if (window.LOCAL_API) return window.LOCAL_API(path, { method, json });
  const headers = { "X-App-Token": TOKEN };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // FormData (file uploads) sets its own Content-Type
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new Error("The app's local server isn't responding. Try quitting and reopening the app.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (code ${res.status}).`);
  return data;
}

// ---------- Small UI helpers ----------

const $ = (sel) => document.querySelector(sel);

// Show a problem at the top of the window. With reload, adds a button to start
// fresh after fixing it (e.g. a typo in config.yaml).
function showError(message, reload = false) {
  const el = $("#error-banner");
  el.textContent = message;
  el.hidden = !message;
  if (message && reload) {
    const button = document.createElement("button");
    button.className = "link-button";
    button.textContent = "I've fixed it – reload";
    button.addEventListener("click", () => location.reload());
    el.append(" ", button);
  }
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  showError("");
  if (name === "saved") loadSavedList();
  if (name === "usage") loadUsage();
}

document.querySelectorAll("#nav button").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view)));

// ---------- Lesson outline ("seed"): upload or paste ----------

let STATUS = {}; // app info from /api/status (limits, version, mock flag, platform)

// Mac words, swapped for their Windows equivalents when running on Windows.
const onWindows = () => STATUS.platform === "windows";
const onWeb = () => STATUS.platform === "web";
const words = () => onWindows()
  ? { trash: "Recycle Bin", finder: "File Explorer", keychain: "Windows Credential Manager" }
  : { trash: "Trash", finder: "Finder", keychain: "Keychain" };

// Read a chosen file in the window, send it to the server, put the extracted text in the box.
$("#seed-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = ""; // allow choosing the same file again later
  if (!file) return;
  showError("");

  const maxBytes = (STATUS.max_upload_mb || 10) * 1024 * 1024;
  if (file.size > maxBytes) {
    showError(`“${file.name}” is larger than ${STATUS.max_upload_mb} MB. Try a smaller file or paste the text.`);
    return;
  }
  if ($("#seed-text").value.trim() && !confirm("Replace the text already in the box with this file?")) return;

  $("#seed-info").textContent = `Reading ${file.name}…`;
  try {
    const data_base64 = await fileToBase64(file);
    const result = await api("/api/seed/read", { method: "POST", json: { filename: file.name, data_base64 } });
    $("#seed-text").value = result.text;
    $("#seed-info").textContent = `Read ${result.words.toLocaleString()} words from ${file.name}`;
    updateSeedCount();
  } catch (e) {
    $("#seed-info").textContent = fileTypesText();
    showError(e.message);
  }
});

// e.g. ".docx, .pdf, .txt, or .md" (the file types this version can read)
function fileTypesText() {
  const types = STATUS.allowed_types?.length ? STATUS.allowed_types : [".docx", ".pdf", ".txt", ".md"];
  if (types.length < 3) return types.join(" or ");
  return `${types.slice(0, -1).join(", ")}, or ${types[types.length - 1]}`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // drop the "data:...;base64," prefix
    reader.onerror = () => reject(new Error(`Couldn't open “${file.name}”.`));
    reader.readAsDataURL(file);
  });
}

function updateSeedCount() {
  const text = $("#seed-text").value;
  const limit = STATUS.max_seed_characters || 60000;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const el = $("#seed-count");
  el.textContent = words ? `${words.toLocaleString()} words · ${text.length.toLocaleString()} / ${limit.toLocaleString()} characters` : "";
  el.classList.toggle("over", text.length > limit);
}
$("#seed-text").addEventListener("input", updateSeedCount);

// "Insert this example": fill the outline (and any empty options) so a new teacher can try the app.
$("#insert-example").addEventListener("click", () => {
  if ($("#seed-text").value.trim() && !confirm("Replace the text already in the box with the example?")) return;
  $("#seed-text").value = $("#outline-example").textContent;
  const gradeWasEmpty = !$("#opt-grade").value;
  if (gradeWasEmpty) $("#opt-grade").value = "6th grade";
  if (!$("#opt-subject").value) $("#opt-subject").value = "Math";
  if (!$("#opt-topic").value) $("#opt-topic").value = "Dividing fractions";
  // The example's Grade 6 TEKS only make sense if we also set the grade.
  if (gradeWasEmpty && !TEKS_CHOSEN.length && TEKS_INDEX.has("6.3A")) { toggleTeks("6.3A", true); toggleTeks("6.3E", true); }
  $("#seed-info").textContent = "Example inserted. Edit it, or click Generate packet to try it.";
  updateSeedCount();
});

// ---------- TEKS picker ----------

let TEKS = { courses: [] };   // built-in official TEKS, from /api/standards
let TEKS_CHOSEN = [];         // codes the teacher ticked, in the order picked
const TEKS_INDEX = new Map(); // code -> official wording (for chip tooltips)

async function loadStandards() {
  TEKS = await api("/api/standards");
  const select = $("#teks-course");
  for (const c of TEKS.courses) {
    select.add(new Option(c.note.startsWith("Adopted 2025") ? `${c.name} (2025 TEKS)` : c.name, c.id));
    for (const s of c.strands) for (const e of s.expectations) TEKS_INDEX.set(e.code, e.text);
  }
  $("#teks-source").textContent = `Official wording from TEA: ${TEKS.title} (${TEKS.source_version}).`;
}

$("#teks-course").addEventListener("change", () => {
  // Fill grade and subject from the course if the teacher hasn't yet.
  const course = TEKS.courses.find((c) => c.id === $("#teks-course").value);
  if (course && !$("#opt-grade").value) $("#opt-grade").value = `${course.grade}th grade`;
  if (course && !$("#opt-subject").value) $("#opt-subject").value = course.subject === "Mathematics" ? "Math" : course.subject;
  renderTeksList();
});
$("#teks-search").addEventListener("input", renderTeksList);

// The list of checkable TEKS: the chosen course, filtered by the search (or every course when searching without one).
function renderTeksList() {
  const list = $("#teks-list");
  const courseId = $("#teks-course").value;
  const query = $("#teks-search").value.trim().toLowerCase();
  list.innerHTML = "";
  list.hidden = !(courseId || query);
  if (list.hidden) return;
  const courses = courseId ? TEKS.courses.filter((c) => c.id === courseId) : TEKS.courses;
  let shown = 0;
  for (const course of courses) {
    for (const strand of course.strands) {
      const matches = strand.expectations.filter((e) =>
        !query || e.code.toLowerCase().includes(query) || e.text.toLowerCase().includes(query));
      if (!matches.length) continue;
      const heading = document.createElement("h4");
      const number = strand.expectations[0].code.replace(/[A-Z]$/, ""); // e.g. "6.7" (strands can share a title)
      heading.textContent = courseId ? `${number} ${strand.title}` : `${course.name} · ${number} ${strand.title}`;
      list.append(heading);
      for (const e of matches) {
        const label = document.createElement("label");
        label.className = "teks-item";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = TEKS_CHOSEN.includes(e.code);
        box.addEventListener("change", () => toggleTeks(e.code, box.checked));
        const code = document.createElement("code");
        code.textContent = e.code;
        const text = document.createElement("span");
        text.textContent = e.text;
        label.append(box, code, text);
        list.append(label);
        shown++;
      }
    }
  }
  if (!shown) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No TEKS match that search.";
    list.append(none);
  }
}

function toggleTeks(code, on) {
  TEKS_CHOSEN = on ? [...new Set([...TEKS_CHOSEN, code])] : TEKS_CHOSEN.filter((c) => c !== code);
  renderTeksChips();
}

// Chosen TEKS as removable chips (hover shows the official wording).
function renderTeksChips() {
  const box = $("#teks-selected");
  box.innerHTML = "";
  for (const code of TEKS_CHOSEN) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.title = TEKS_INDEX.get(code) || "";
    chip.append(`TEKS ${code}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove TEKS ${code}`);
    remove.addEventListener("click", () => { toggleTeks(code, false); renderTeksList(); });
    chip.append(remove);
    box.append(chip);
  }
}

// ---------- Options ----------

// Gather the form into one object. Keys match the {{placeholders}} in the prompts.
function collectOptions() {
  return {
    seed: $("#seed-text").value.trim(),
    grade_level: $("#opt-grade").value.trim(),
    subject: $("#opt-subject").value.trim(),
    topic: $("#opt-topic").value.trim(),
    standards: $("#opt-standards").value.trim(),
    teks: [...TEKS_CHOSEN],
    elps: $("#opt-elps").checked,
    spanish: $("#opt-spanish").checked,
    num_days: Number($("#opt-days").value),
    class_minutes: Number($("#opt-minutes").value),
    notes: $("#opt-notes").value.trim(),
  };
}

// Returns a message describing what's missing, or "" if the form is ready.
function checkOptions(o) {
  if (!o.seed) return "Add your lesson outline: type or paste it, or upload a file. (See “What should I include?” for help.)";
  const limit = STATUS.max_seed_characters || 60000;
  if (o.seed.length > limit) return `Your lesson outline is too long (${o.seed.length.toLocaleString()} characters; the limit is ${limit.toLocaleString()}). Shorten it` + (onWeb() ? "." : ", or raise max_seed_characters in config.yaml.");
  return "";
}

// ---------- Sections to include ----------

let SECTIONS = []; // from sections.yaml, in packet order: [{id, name, on_by_default, ...}]

async function loadSections() {
  SECTIONS = (await api("/api/sections")).sections;
  const box = $("#section-choices");
  box.innerHTML = "";
  for (const s of SECTIONS) {
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = s.id;
    check.checked = s.on_by_default !== false;
    label.append(check, " " + s.name);
    box.appendChild(label);
  }
}

function chosenSections() {
  const ids = [...document.querySelectorAll("#section-choices input:checked")].map((c) => c.value);
  return SECTIONS.filter((s) => ids.includes(s.id));
}

// ---------- The packet ----------

// Everything about the packet on screen. This whole object is what gets saved.
//   id:       file name once saved (null for a new, unsaved packet)
//   title:    shown in the Saved list and at the top of exports
//   options:  the form values it was generated from
//   order:    section ids, in display order
//   sections: { id: {section_id, name, markdown, model, usage, cost, warning, edited, previous} }
//             (previous = the text before the last regenerate/revise, for Undo)
//   instructions: { id: saved "Section instructions" text, used on every regenerate }
//   spent:    estimated dollars spent on this packet, including regenerations
let PACKET = null;
let DIRTY = false;   // true when there are changes that haven't been saved
let IN_FLIGHT = 0;   // sections currently being written by Claude

function defaultTitle(o) {
  return [o.topic, o.grade_level, o.subject].filter(Boolean).join(" – ") || "Untitled packet";
}

$("#packet-form").addEventListener("submit", async (event) => {
  event.preventDefault(); // the browser checks required fields first, then we check the rest
  const options = collectOptions();
  const chosen = chosenSections();
  const problem = checkOptions(options) || (chosen.length ? "" : "Choose at least one section to write.");
  showError(problem);
  if (problem) return;
  if (DIRTY && !confirm("The packet on screen has unsaved changes. Replace it with a new one anyway?")) return;

  if (IN_FLIGHT && !confirm("A section is still being written. Start a new packet anyway? (That section will be discarded.)")) return;

  const packet = { id: null, title: defaultTitle(options), options, order: chosen.map((s) => s.id),
                   sections: {}, instructions: {}, spent: 0 };
  PACKET = packet;
  renderPacket();
  markDirty();
  $("#packet").hidden = false;
  $("#generate-btn").disabled = true;

  // The lesson plan goes first: the other sections are built from it.
  // Then the rest are written at the same time, which is much faster.
  const rest = chosen.filter((s) => s.id !== "lesson_plan");
  let failures = 0;
  if (packet.order.includes("lesson_plan")) {
    // Lock the other cards until it's their turn (otherwise a click could write them twice).
    for (const s of rest) setCardBusy(cardFor(s.id), true, "Waiting for the lesson plan…");
    $("#progress").textContent = "Writing the lesson plan… (about a minute)";
    if (!(await runSection("lesson_plan", null, packet))) failures++;
  }
  // A section that follows another (Student Notes follow the slides) waits for it.
  const waits = (s) => s.follows && rest.some((r) => r.id === s.follows);
  const now = rest.filter((s) => !waits(s));
  const after = rest.filter(waits);
  // If another packet was opened meanwhile, don't spend money on this one.
  if (now.length && PACKET === packet) {
    for (const s of after) setCardBusy(cardFor(s.id), true, `Waiting for ${sectionName(s.follows)}…`);
    $("#progress").textContent = `Writing ${now.length} more section${now.length > 1 ? "s" : ""} at the same time…`;
    const results = await Promise.all(now.map((s) => runSection(s.id, null, packet)));
    failures += results.filter((ok) => !ok).length;
  }
  if (after.length && PACKET === packet) {
    $("#progress").textContent = `Writing ${after.map((s) => s.name).join(" and ")}…`;
    const results = await Promise.all(after.map((s) => runSection(s.id, null, packet)));
    failures += results.filter((ok) => !ok).length;
  }

  $("#generate-btn").disabled = false;
  if (PACKET !== packet) return;
  $("#progress").textContent = failures
    ? `Done, but ${failures} section${failures > 1 ? "s" : ""} failed. Use “Regenerate from scratch” on those sections to try again.`
    : "Done. Review each section below.";
});

// Draw an empty card for every section in the packet.
function renderPacket() {
  const holder = $("#packet-sections");
  holder.innerHTML = "";
  for (const id of PACKET.order) {
    const card = $("#section-template").content.firstElementChild.cloneNode(true);
    card.dataset.sectionId = id;
    card.querySelector(".section-name").textContent = sectionName(id);
    wireCard(card, id);
    card.querySelector(".section-text").hidden = true;      // nothing to show until it's written
    card.querySelector(".toggle-preview").hidden = true;
    card.querySelector(".regen-notes").value = PACKET.instructions[id] || "";
    holder.appendChild(card);
    if (PACKET.sections[id]) fillCard(id);
  }
  $("#packet-title").value = PACKET.title || "";
  updateTotal();
  updateSaveStatus();
  updatePacketMenus();
}

// The section this one is built from (sections.yaml "follows"), e.g. slides for Student Notes.
const followsOf = (id) => SECTIONS.find((s) => s.id === id)?.follows || "";

function sectionName(id) {
  return PACKET.sections[id]?.name || SECTIONS.find((s) => s.id === id)?.name || id;
}

const cardFor = (id) => document.querySelector(`.section[data-section-id="${CSS.escape(id)}"]`);

// Buttons and typing inside one section card.
function wireCard(card, id) {
  const text = card.querySelector(".section-text");
  const preview = card.querySelector(".section-preview");

  text.addEventListener("input", () => {
    if (!PACKET.sections[id]) return;
    PACKET.sections[id].markdown = text.value;
    PACKET.sections[id].edited = true;
    markDirty();
  });

  card.querySelector(".toggle-preview").addEventListener("click", () =>
    setMode(card, preview.hidden ? "preview" : "edit"));

  // Section instructions: the "tuning knob", saved with the packet.
  card.querySelector(".regen-notes").addEventListener("input", (event) => {
    PACKET.instructions[id] = event.target.value;
    markDirty();
  });

  card.querySelector(".regen-btn").addEventListener("click", async () => {
    if (PACKET.sections[id]?.edited &&
        !confirm("Regenerating writes this section from scratch and replaces your edits (you can Undo). Continue?")) return;
    if (await runSection(id)) lessonPlanChanged(id);
  });

  // Quick change: Claude edits the current text, keeping everything else.
  const revise = card.querySelector(".revise-notes");
  const runRevise = async () => {
    if (!PACKET.sections[id]) return;
    if (!revise.value.trim()) {
      revise.focus();
      return;
    }
    if (await runSection(id, revise.value)) {
      revise.value = ""; // a quick change is a one-off
      lessonPlanChanged(id);
    }
  };
  card.querySelector(".revise-btn").addEventListener("click", runRevise);
  revise.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runRevise();
  });

  // Undo swaps the current text with the previous version (click again to redo).
  card.querySelector(".undo-btn").addEventListener("click", () => {
    const data = PACKET.sections[id];
    if (!data || data.previous == null) return;
    [data.markdown, data.previous] = [data.previous, data.markdown];
    data.undone = !data.undone;
    fillCard(id);
    markDirty();
  });
}

function lessonPlanChanged(id) {
  const followers = PACKET.order.filter((other) => followsOf(other) === id && PACKET.sections[other]);
  if (followers.length) {
    $("#progress").textContent = `${sectionName(id)} updated. ${followers.map(sectionName).join(" and ")} ` +
      "were based on the previous version; regenerate or revise them so they match.";
  } else if (id === "lesson_plan" && PACKET.order.length > 1) {
    $("#progress").textContent = "Lesson plan updated. The other sections were based on the previous version; regenerate or revise any that should match.";
  }
}

// Ask the server to write one section and show the result in its card. Returns true on success.
// With a reviseRequest, Claude edits the section's current text instead of writing it from scratch.
async function runSection(id, reviseRequest = null, packet = PACKET) {
  const card = cardFor(id);
  const before = packet.sections[id]?.markdown;
  setCardBusy(card, true, reviseRequest ? "Revising…" : "Writing… (about a minute)");
  IN_FLIGHT++;
  try {
    const result = await api("/api/generate", {
      method: "POST",
      json: {
        options: packet.options,
        section_id: id,
        lesson_plan: id === "lesson_plan" ? "" : (packet.sections.lesson_plan?.markdown || ""),
        extra_instructions: reviseRequest ?? (packet.instructions[id] || ""),
        current_text: reviseRequest ? before : "",
        follow_text: packet.sections[followsOf(id)]?.markdown || "",
      },
    });
    packet.sections[id] = { ...result, edited: false, previous: before ?? null, undone: false };
    packet.spent += result.cost || 0;
    // Another packet was opened while this was being written: keep the result
    // out of it (the packet on screen must never receive another packet's text).
    if (PACKET !== packet) return false;
    fillCard(id);
    markDirty();
    updatePacketMenus();
    return true;
  } catch (e) {
    const error = card.querySelector(".section-error");
    error.textContent = e.message;
    error.hidden = false;
    return false;
  } finally {
    IN_FLIGHT--;
    setCardBusy(card, false);
    updateTotal();
  }
}

function showCardMessage(card, message) {
  const busy = card.querySelector(".section-busy");
  busy.textContent = message;
  busy.hidden = !message;
}

function setCardBusy(card, busy, message = "Writing… (about a minute)") {
  showCardMessage(card, busy ? message : "");
  card.querySelector(".section-text").disabled = busy;
  card.querySelector(".regen-btn").disabled = busy;
  card.querySelector(".revise-btn").disabled = busy;
  card.querySelector(".undo-btn").disabled = busy;
  card.querySelector(".toggle-preview").disabled = busy;
  if (busy) card.querySelector(".section-error").hidden = true;
}

// Show a section's text, warning, and usage line in its card.
function fillCard(id) {
  const card = cardFor(id);
  const data = PACKET.sections[id];
  card.querySelector(".section-text").value = data.markdown;
  card.querySelector(".toggle-preview").hidden = false;
  setMode(card, "preview"); // new text always opens formatted
  const warning = card.querySelector(".section-warning");
  warning.textContent = data.warning || "";
  warning.hidden = !data.warning;
  card.querySelector(".section-meta").textContent = data.usage ? describeUsage(data) : "";
  const undo = card.querySelector(".undo-btn");
  undo.hidden = data.previous == null;
  undo.textContent = data.undone ? "Redo change" : "Undo last change";
}

// Show a card's text either formatted ("preview") or as editable Markdown ("edit").
function setMode(card, mode) {
  const text = card.querySelector(".section-text");
  const preview = card.querySelector(".section-preview");
  const showPreview = mode === "preview";
  if (showPreview) preview.innerHTML = renderMarkdown(text.value);
  preview.hidden = !showPreview;
  text.hidden = showPreview;
  card.querySelector(".toggle-preview").textContent = showPreview ? "Edit" : "Preview";
  if (!showPreview) text.focus();
}

function updateTotal() {
  const el = $("#packet-total");
  el.textContent = PACKET && PACKET.spent
    ? `Estimated cost of this packet so far, including regenerations: about $${PACKET.spent.toFixed(2)}`
    : "";
  if (!PACKET || !PACKET.spent) return;
  // Add the month's running total (from the local usage log).
  api("/api/usage").then((u) => {
    el.textContent += ` · This month so far: about $${u.this_month.cost.toFixed(2)}`;
  }).catch(() => {});
}

// e.g. "claude-opus-5-5 · 1,830 tokens in · 2,410 out · about $0.06"
function describeUsage(result) {
  const u = result.usage;
  const tokensIn = u.input_tokens + u.cache_write_tokens + u.cache_read_tokens;
  const cost = result.cost == null ? `cost unknown (no price${onWeb() ? " listed for this model" : " in config.yaml"})` : `about $${result.cost.toFixed(2)}`;
  return `${result.model} · ${tokensIn.toLocaleString()} tokens in · ${u.output_tokens.toLocaleString()} out · ${cost}`;
}

// ---------- Save and reopen ----------

function markDirty() {
  DIRTY = true;
  updateSaveStatus();
}

function updateSaveStatus() {
  // In the app window, tell it whether closing should ask first.
  window.pywebview?.api?.set_unsaved(DIRTY);
  window.onUnsavedChange?.(DIRTY); // web version: warn before the tab closes
  const el = $("#save-status");
  if (!PACKET) return;
  el.textContent = DIRTY ? "Unsaved changes" : PACKET.saved_at ? `Saved ${formatTime(PACKET.saved_at)}` : "";
  el.classList.toggle("unsaved", DIRTY);
}

function formatTime(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

$("#packet-title").addEventListener("input", () => {
  if (!PACKET) return;
  PACKET.title = $("#packet-title").value;
  markDirty();
});

$("#save-btn").addEventListener("click", savePacket);

// ⌘S (Ctrl+S on Windows) saves, like other apps.
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    savePacket();
  }
});

async function savePacket() {
  if (!PACKET) return;
  try {
    const saved = await api("/api/packets", { method: "POST", json: PACKET });
    PACKET.id = saved.id;
    PACKET.title = saved.title;
    PACKET.saved_at = saved.saved_at;
    $("#packet-title").value = saved.title;
    DIRTY = false;
    updateSaveStatus();
  } catch (e) {
    showError(e.message);
  }
}

async function loadSavedList() {
  const list = $("#saved-list");
  try {
    const { packets } = await api("/api/packets");
    list.innerHTML = "";
    $("#saved-empty").hidden = packets.length > 0;
    for (const p of packets) {
      const row = $("#saved-row-template").content.firstElementChild.cloneNode(true);
      row.querySelector(".saved-title").textContent = p.title;
      row.querySelector(".saved-meta").textContent =
        [p.grade_level, p.subject, `${p.sections} section${p.sections === 1 ? "" : "s"}`, `saved ${formatTime(p.saved_at)}`]
          .filter(Boolean).join(" · ");
      row.querySelector(".open-btn").addEventListener("click", () => openPacket(p.id));
      row.querySelector(".delete-btn").addEventListener("click", () => deletePacket(p));
      list.appendChild(row);
    }
  } catch (e) {
    showError(e.message);
  }
}

async function openPacket(id) {
  if (IN_FLIGHT && !confirm("A section is still being written for the packet on screen. Open another packet anyway? (That section will be discarded.)")) return;
  if (DIRTY && !confirm("The packet on screen has unsaved changes. Open another one anyway?")) return;
  try {
    PACKET = await api(`/api/packets/${encodeURIComponent(id)}`);
    PACKET.spent = PACKET.spent || 0;
    PACKET.instructions = PACKET.instructions || {}; // packets saved before this feature
    DIRTY = false;
    fillForm(PACKET.options);
    showView("packet");
    renderPacket();
    $("#packet").hidden = false;
    $("#progress").textContent = "";
    $("#packet").scrollIntoView();
  } catch (e) {
    showError(e.message);
  }
}

async function deletePacket(p) {
  const putBack = onWindows() ? "choose Restore" : "choose File › Put Back";
  const question = onWeb()
    ? `Delete “${p.title}” from this browser?\n\nThis can't be undone (unless it's in a backup you downloaded).`
    : `Move “${p.title}” to the ${words().trash}?\n\nTo get it back, open the ${words().trash}, select its two files, and ${putBack}.`;
  if (!confirm(question)) return;
  try {
    await api(`/api/packets/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    if (PACKET && PACKET.id === p.id) PACKET.id = null; // still on screen; saving makes a new copy
    loadSavedList();
  } catch (e) {
    showError(e.message);
  }
}

// Put a saved packet's options back into the form, so regenerating uses them.
function fillForm(o) {
  $("#seed-text").value = o.seed || "";
  $("#opt-grade").value = o.grade_level || "";
  $("#opt-subject").value = o.subject || "";
  $("#opt-topic").value = o.topic || "";
  $("#opt-standards").value = o.standards || "";
  TEKS_CHOSEN = [...(o.teks || [])];
  $("#opt-elps").checked = !!o.elps;
  $("#opt-spanish").checked = !!o.spanish;
  renderTeksChips();
  renderTeksList();
  $("#opt-days").value = o.num_days || 1;
  $("#opt-minutes").value = o.class_minutes || 50;
  $("#opt-notes").value = o.notes || "";
  $("#seed-info").textContent = fileTypesText();
  updateSeedCount();
}

// Warn before closing the window with unsaved changes.
window.addEventListener("beforeunload", (event) => {
  if (DIRTY) event.preventDefault();
});

// ---------- Export ----------

// Fill the "Export ___" and "Add a section" menus from the current packet.
function updatePacketMenus() {
  if (!PACKET) return;
  const scope = $("#export-scope");
  const previous = scope.value;
  scope.innerHTML = "";
  scope.add(new Option("Whole packet", ""));
  for (const id of PACKET.order) {
    if (PACKET.sections[id]) scope.add(new Option(sectionName(id), id));
  }
  scope.value = [...scope.options].some((o) => o.value === previous) ? previous : "";

  const add = $("#add-section");
  add.innerHTML = "";
  for (const s of SECTIONS) {
    if (!PACKET.order.includes(s.id)) add.add(new Option(s.name, s.id));
  }
  $("#add-section-row").hidden = add.options.length === 0;
  updateExportHint();
}

// A gentle tip when exporting non-slide content to PowerPoint.
function updateExportHint() {
  const format = $("#export-format").value;
  const scope = $("#export-scope").value;
  let hint = "";
  if (format === "pptx" && scope !== "slides") {
    hint = PACKET && PACKET.sections.slides
      ? "Tip: for slides to project in class, choose “Presentation Slides” above. Other sections are converted automatically and can be text-heavy."
      : "Tip: other sections are converted to slides automatically and can be text-heavy. For slides made to project in class, add “Presentation Slides” below.";
  }
  $("#export-hint").textContent = hint;
}
$("#export-format").addEventListener("change", updateExportHint);
$("#export-scope").addEventListener("change", updateExportHint);

$("#export-btn").addEventListener("click", async () => {
  if (!PACKET) return;
  const button = $("#export-btn");
  const result = $("#export-result");
  button.disabled = true;
  result.className = "hint";
  result.textContent = onWeb() ? "Preparing the file…" : "Choose where to save it…";
  try {
    const saved = await api("/api/export", {
      method: "POST",
      json: { packet: PACKET, section_id: $("#export-scope").value || null, format: $("#export-format").value },
    });
    if (saved.cancelled) {
      result.textContent = "";
      return;
    }
    if (saved.downloaded) { // web version: the browser saves it (usually to Downloads)
      result.textContent = `Downloaded “${saved.name}”. Look in your Downloads folder.`;
      return;
    }
    result.textContent = `Saved “${saved.name}”. `;
    const show = document.createElement("button");
    show.className = "link-button";
    show.textContent = `Show in ${words().finder}`;
    show.addEventListener("click", () => api("/api/reveal", { method: "POST", json: { path: saved.path } }).catch((e) => showError(e.message)));
    result.appendChild(show);
  } catch (e) {
    // Show it right here (next to the button) as well as at the top of the window.
    result.className = "hint inline-error";
    result.textContent = `Couldn't export: ${e.message}`;
    showError(e.message);
  } finally {
    button.disabled = false;
  }
});

// Write a section that wasn't part of the packet yet (e.g. Presentation Slides).
$("#add-section-btn").addEventListener("click", async () => {
  const id = $("#add-section").value;
  if (!PACKET || !id) return;
  // Insert it where sections.yaml puts it (sections no longer listed there stay at the end).
  const rank = (sid) => { const i = SECTIONS.findIndex((s) => s.id === sid); return i < 0 ? 999 : i; };
  PACKET.order = [...PACKET.order, id].sort((a, b) => rank(a) - rank(b));
  renderPacket();
  cardFor(id).scrollIntoView({ behavior: "smooth" });
  await runSection(id);
});

// ---------- Usage page ----------

async function loadUsage() {
  try {
    const u = await api("/api/usage");
    const m = u.this_month;
    $("#usage-month-cost").textContent = `$${m.cost.toFixed(2)}`;
    $("#usage-month-name").textContent = monthName(m.month);
    $("#usage-month-detail").textContent = m.calls
      ? `${m.calls} section${m.calls === 1 ? "" : "s"} written · ${m.input_tokens.toLocaleString()} tokens in · ${m.output_tokens.toLocaleString()} tokens out` +
        (m.unpriced_calls ? ` · ${m.unpriced_calls} with no price ${onWeb() ? "listed" : "in config.yaml"} (not included)` : "")
      : "Nothing generated yet this month.";
    $("#usage-models").textContent = u.by_model.length > 1
      ? "By model: " + u.by_model.map((b) => `${b.model} $${b.cost.toFixed(2)} (${b.calls})`).join(" · ")
      : "";

    USAGE = u;
    RECORDS_SHOWN = RECORDS_PAGE;
    showUsageHistory();
    showRunningTotals();
    showUsageRecords();
    $("#usage-empty").hidden = u.history.length > 0;
  } catch (e) {
    showError(e.message);
  }
}

// ---- Usage by day / week / month, and running totals (added up from the daily totals) ----

let USAGE = null;
let USAGE_PERIOD = "month";

const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
// Weeks run Sunday to Saturday (like a US school calendar): a week is named by its Sunday.
const weekOf = (s) => { const d = parseDate(s); d.setDate(d.getDate() - d.getDay()); return isoDate(d); };
const money = (cost) => (cost > 0 && cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`);

function addUp(days) {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
  for (const d of days) {
    total.calls += d.calls;
    total.input_tokens += d.input_tokens;
    total.output_tokens += d.output_tokens;
    total.cost += d.cost;
  }
  return total;
}

function showRunningTotals() {
  const days = USAGE?.days || [];
  const today = isoDate(new Date());
  const tiles = {
    today: days.filter((d) => d.date === today),
    week: days.filter((d) => weekOf(d.date) === weekOf(today)),
    month: days.filter((d) => d.date.slice(0, 7) === today.slice(0, 7)),
    all: days,
  };
  const ids = { today: "#usage-today", week: "#usage-week", month: "#usage-month", all: "#usage-all" };
  const details = { today: "#usage-today-detail", week: "#usage-week-detail", month: "#usage-month-tile-detail", all: "#usage-all-detail" };
  for (const [name, list] of Object.entries(tiles)) {
    const t = addUp(list);
    $(ids[name]).textContent = money(t.cost);
    $(details[name]).textContent = `${t.calls} section${t.calls === 1 ? "" : "s"}`;
  }
}

function showUsageHistory() {
  const days = USAGE?.days;
  const body = $("#usage-history");
  body.innerHTML = "";
  let rows;
  if (!days) { // an older app version: months only
    rows = (USAGE?.history || []).map((h) => [monthName(h.month), h]);
  } else {
    const key = { day: (d) => d.date, week: (d) => weekOf(d.date), month: (d) => d.date.slice(0, 7) }[USAGE_PERIOD];
    const groups = new Map();
    for (const d of days) groups.set(key(d), [...(groups.get(key(d)) || []), d]);
    const label = {
      day: (k) => parseDate(k).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      week: (k) => `Week of ${parseDate(k).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`,
      month: (k) => monthName(k),
    }[USAGE_PERIOD];
    rows = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([k, list]) => [label(k), addUp(list)]);
  }
  $("#usage-period-label").textContent = { day: "Day", week: "Week", month: "Month" }[USAGE_PERIOD];
  for (const [label, t] of rows) {
    const row = body.insertRow();
    for (const value of [label, t.calls, t.input_tokens.toLocaleString(), t.output_tokens.toLocaleString(), money(t.cost)]) {
      row.insertCell().textContent = value;
    }
  }
}

// ---- All records: every section written, newest first ----

const RECORDS_PAGE = 50;
let RECORDS_SHOWN = RECORDS_PAGE;

function recordSectionName(id) {
  const revise = id.endsWith(" (revise)");
  const base = revise ? id.slice(0, -" (revise)".length) : id;
  const name = SECTIONS.find((s) => s.id === base)?.name || base.replaceAll("_", " ");
  return revise ? `${name} · Quick change` : name;
}

function showUsageRecords() {
  const records = USAGE?.records || [];
  const body = $("#usage-records");
  body.innerHTML = "";
  for (const r of records.slice(0, RECORDS_SHOWN)) {
    const when = new Date(r.time);
    const row = body.insertRow();
    const values = [
      Number.isNaN(when.getTime()) ? r.time : when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
      recordSectionName(r.section), r.input_tokens.toLocaleString(), r.output_tokens.toLocaleString(),
      r.cost === null ? "no price" : money(r.cost),
    ];
    for (const value of values) row.insertCell().textContent = value;
  }
  $("#usage-records-empty").hidden = records.length > 0;
  const more = $("#usage-more");
  more.hidden = records.length <= RECORDS_SHOWN;
  more.textContent = `Show more (${(records.length - RECORDS_SHOWN).toLocaleString()} older)`;
  $("#usage-since").textContent = USAGE?.counting_since
    ? `Totals count from ${new Date(USAGE.counting_since).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}, `
      + "when you started the count over; all records are kept below."
    : "";
}

$("#usage-more").addEventListener("click", () => {
  RECORDS_SHOWN += RECORDS_PAGE;
  showUsageRecords();
});

$("#usage-show-file").addEventListener("click", () =>
  api("/api/open/data", { method: "POST" }).catch((e) => showError(e.message)));

document.querySelectorAll(".segmented button").forEach((b) => b.addEventListener("click", () => {
  USAGE_PERIOD = b.dataset.period;
  document.querySelectorAll(".segmented button").forEach((x) => x.classList.toggle("active", x === b));
  showUsageHistory();
}));

function monthName(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString([], { month: "long", year: "numeric" });
}

$("#usage-open-folder").addEventListener("click", () =>
  api("/api/open/data", { method: "POST" }).catch((e) => showError(e.message)));

// ---------- Settings: prompts ----------

async function settingsAction(path, message) {
  try {
    await api(path, { method: "POST" });
    $("#prompts-result").textContent = message;
  } catch (e) {
    showError(e.message);
  }
}
$("#open-prompts").addEventListener("click", () => settingsAction("/api/open/prompts", `Opened the prompts folder in ${words().finder}.`));
$("#open-data").addEventListener("click", () => settingsAction("/api/open/data", `Opened the data folder in ${words().finder}.`));
$("#reset-prompts").addEventListener("click", async () => {
  if (!confirm("Replace all prompt files and sections.yaml with the original versions? Your edits to them will be lost.")) return;
  await settingsAction("/api/prompts/reset", "Prompts and sections.yaml were reset to the defaults.");
  $("#prompts-outdated").hidden = true;
  await loadSections();
});

// ---------- API key (welcome + settings) ----------

// Put a "paste key → Test and save" form into `container`. Calls onSaved(result) on success.
function mountKeyForm(container, onSaved) {
  const form = $("#key-form-template").content.firstElementChild.cloneNode(true);
  const input = form.querySelector(".key-input");
  const result = form.querySelector(".key-result");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    result.className = "key-result muted";
    result.textContent = "Testing the key with a tiny request to Claude…";
    try {
      const remember = form.querySelector(".key-remember")?.checked || false; // web version only
      const saved = await api("/api/key", { method: "POST", json: { key: input.value, remember } });
      input.value = ""; // don't leave the key sitting in the page
      result.className = "key-result ok";
      result.textContent = STATUS.mock
        ? `✓ Key saved in ${saved.where || words().keychain} (${saved.masked}). It was NOT tested, because MOCK mode never contacts Claude.`
        : `✓ Key works and is saved in ${saved.where || words().keychain} (${saved.masked}).` + (saved.warning ? ` Note: ${saved.warning}` : "");
      onSaved(saved);
    } catch (e) {
      result.className = "key-result error";
      result.textContent = `✗ ${e.message}`;
    } finally {
      button.disabled = false;
    }
  });
  container.appendChild(form);
}

mountKeyForm($("#welcome-key-form"), () => {
  refreshKeyStatus();
  $("#welcome-limit").hidden = false;
  $("#welcome-limit").scrollIntoView({ behavior: "smooth" });
});
$("#welcome-done").addEventListener("click", () => {
  $("#nav").hidden = false;
  showView("packet");
});

mountKeyForm($("#settings-key-form"), refreshKeyStatus);

$("#remove-key").addEventListener("click", async () => {
  if (!confirm("Remove your Claude API key from this computer? You'll need to paste it again to generate packets.")) return;
  try {
    await api("/api/key", { method: "DELETE" });
    await refreshKeyStatus();
  } catch (e) {
    showError(e.message);
  }
});

async function refreshKeyStatus() {
  const key = await api("/api/key");
  const where = !onWeb() ? "" : key.remembered ? " (remembered in this browser)" : " (for this tab only)";
  $("#settings-key-status").textContent = key.saved
    ? `A key is saved${where}: ${key.masked}. To replace it, paste a new one below.`
    : "No key is saved. Paste one below to generate packets.";
  $("#remove-key").hidden = !key.saved;
  return key;
}

// ---------- Startup ----------

// Each part loads on its own, so one problem (like a settings typo) doesn't stop the rest.
async function start() {
  const problems = [];
  try {
    // First, so the page uses the right words (Mac or Windows) from the start.
    STATUS = await api("/api/status");
    $("#mock-banner").hidden = !STATUS.mock;
    $("#about-version").textContent = STATUS.version;
    $("#about-model").textContent = STATUS.model;
    $("#about-data-dir").textContent = STATUS.data_dir;
    document.documentElement.dataset.platform = STATUS.platform; // shows/hides .web-only and .desktop-only parts
    const variant = { windows: "win", web: "web" }[STATUS.platform];
    if (variant) document.querySelectorAll(`[data-${variant}]`).forEach((el) => { el.textContent = el.dataset[variant]; });
    $("#seed-file").accept = (STATUS.allowed_types || []).join(",") || $("#seed-file").accept;
    if (STATUS.export_formats) { // the web version doesn't make every format yet
      [...$("#export-format").options].forEach((o) => { if (!STATUS.export_formats.includes(o.value)) o.remove(); });
    }
    $("#seed-info").textContent = fileTypesText();
    if (STATUS.settings_problem) problems.push(STATUS.settings_problem);
  } catch (e) {
    problems.push(e.message);
  }
  try {
    // First run: no key yet -> show only the welcome screen.
    const key = await refreshKeyStatus();
    if (!key.saved) {
      $("#nav").hidden = true;
      showView("welcome");
    }
  } catch (e) {
    problems.push(e.message);
  }
  try {
    await loadSections();
  } catch (e) {
    problems.push(e.message);
  }
  try {
    await loadStandards();
  } catch (e) {
    problems.push(e.message);
  }
  const outdated = STATUS.prompts_outdated || [];
  $("#prompts-outdated").hidden = !outdated.length;
  $("#prompts-outdated").textContent = outdated.length
    ? `A newer version of ${outdated.join(", ")} came with this app update, but you've edited your copy, so it was kept. ` +
      "To use the new version, click “Reset prompts to defaults” (this replaces your edits)."
    : "";
  if (problems.length) showError([...new Set(problems)].join(" "), true);
}

start();
