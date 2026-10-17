// The Settings page editors of the web version: Claude settings, sections, and prompts.
// (The desktop apps keep these as files in their data folder instead.)

import { handle as api } from "./local_api.js?v=8b2ec44a96";

const $ = (selector) => document.querySelector(selector);
let SETTINGS = null;      // the latest reply from /api/web/settings
let SECTIONS_DRAFT = [];  // the section list being edited (saved with "Save sections")
let PROMPT_SHOWN = "";    // the prompt in the editor, and its text when loaded
let PROMPT_LOADED_TEXT = "";

function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).className = error ? "hint inline-error" : "hint";
}

export async function startSettingsEditors() {
  SETTINGS = await api("/api/web/settings");
  showConfig();
  SECTIONS_DRAFT = SETTINGS.sections.map((s) => ({ ...s }));
  showSections();
  showPromptList(SETTINGS.prompts[0]?.name);
}

// ---- Claude settings ----

function showConfig() {
  const c = SETTINGS.config;
  $("#ws-model").replaceChildren(...SETTINGS.models.map((m) => new Option(m, m, false, m === c.model)));
  $("#ws-effort").replaceChildren(new Option("(model default)", ""),
    ...SETTINGS.efforts.map((e) => new Option(e, e, false, e === c.effort)));
  $("#ws-effort").value = c.effort || "";
  $("#ws-max").value = c.max_output_tokens;
  $("#ws-new-page").checked = c.new_page_per_section;
  $("#ws-review-note").checked = c.include_review_note;
}

$("#ws-save-config").addEventListener("click", async () => {
  try {
    SETTINGS = await api("/api/web/config", { method: "POST", json: {
      model: $("#ws-model").value, effort: $("#ws-effort").value, max_output_tokens: Number($("#ws-max").value),
      new_page_per_section: $("#ws-new-page").checked, include_review_note: $("#ws-review-note").checked,
    } });
    showConfig();
    $("#about-model").textContent = SETTINGS.config.model;
    say("#ws-config-result", "Saved. New sections use these settings.");
  } catch (e) {
    say("#ws-config-result", e.message, true);
  }
});

// ---- Sections ----

function showSections() {
  const holder = $("#ws-sections");
  holder.replaceChildren();
  SECTIONS_DRAFT.forEach((s, n) => {
    const row = document.createElement("div");
    row.className = "ws-section-row";

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = Boolean(s.on_by_default);
    on.title = "Selected for new packets";
    on.setAttribute("aria-label", `${s.name}: selected for new packets`);
    on.addEventListener("change", () => { s.on_by_default = on.checked; });

    const name = document.createElement("input");
    name.type = "text";
    name.value = s.name;
    name.maxLength = 80;
    name.setAttribute("aria-label", "Section name");
    name.addEventListener("input", () => { s.name = name.value; });

    const file = document.createElement("span");
    file.className = "hint";
    file.textContent = s.prompt_file + (s.follows ? ` · after ${s.follows}` : "");

    const button = (label, title, action, disabled = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "button secondary small";
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", action);
      return b;
    };
    const move = (step) => () => {
      const [item] = SECTIONS_DRAFT.splice(n, 1);
      SECTIONS_DRAFT.splice(n + step, 0, item);
      showSections();
    };
    row.append(on, name, file,
      button("↑", "Move up", move(-1), n === 0),
      button("↓", "Move down", move(1), n === SECTIONS_DRAFT.length - 1),
      button("Remove", "Remove this section", () => {
        const others = SECTIONS_DRAFT.filter((x) => x.follows === s.id).map((x) => x.name);
        const warn = s.id === "lesson_plan" ? "\n\nThe other sections are built from the lesson plan; without it they use your outline directly."
          : others.length ? `\n\n${others.join(" and ")} ${others.length > 1 ? "are" : "is"} built from it.` : "";
        if (!confirm(`Remove “${s.name}”? (Click Save sections to keep the change.)${warn}`)) return;
        SECTIONS_DRAFT.splice(n, 1);
        showSections();
      }));
    holder.appendChild(row);
  });
}

$("#ws-add-section").addEventListener("click", () => {
  const name = $("#ws-new-section").value.trim();
  if (!name) {
    $("#ws-new-section").focus();
    return;
  }
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  if (!/^[a-z]/.test(id)) id = `section_${id}`;
  const base = id;
  for (let n = 2; SECTIONS_DRAFT.some((s) => s.id === id); n++) id = `${base}_${n}`;
  SECTIONS_DRAFT.push({ id, name, prompt_file: `${id}.txt`, on_by_default: true });
  $("#ws-new-section").value = "";
  showSections();
  say("#ws-sections-result", `Added “${name}”. Click Save sections, then write its prompt below.`);
});

$("#ws-save-sections").addEventListener("click", async () => {
  try {
    SETTINGS = await api("/api/web/sections", { method: "POST", json: { sections: SECTIONS_DRAFT } });
    SECTIONS_DRAFT = SETTINGS.sections.map((s) => ({ ...s }));
    showSections();
    showPromptList(PROMPT_SHOWN);
    await window.loadSections?.(); // refresh the checkboxes on the Packet page
    say("#ws-sections-result", "Saved. The Packet page now offers these sections.");
  } catch (e) {
    say("#ws-sections-result", e.message, true);
  }
});

// ---- Prompts ----

function showPromptList(selected) {
  const list = SETTINGS.prompts;
  $("#ws-prompt").replaceChildren(...list.map((p) => {
    const label = p.name + (p.used_by.length ? ` (${p.used_by.join(", ")})` : p.name === "system.txt" ? " (every section)"
      : p.name === "revise.txt" ? " (Quick change)" : "") + (p.edited ? " · edited" : "");
    return new Option(label, p.name);
  }));
  const name = list.some((p) => p.name === selected) ? selected : list[0]?.name;
  $("#ws-prompt").value = name;
  showPrompt(name);
}

function showPrompt(name) {
  const p = SETTINGS.prompts.find((x) => x.name === name);
  if (!p) return;
  PROMPT_SHOWN = name;
  PROMPT_LOADED_TEXT = p.text;
  $("#ws-prompt-text").value = p.text;
  $("#ws-restore-prompt").disabled = !p.edited || p.custom;
  const status = $("#ws-prompt-status");
  status.className = p.outdated ? "hint outdated" : "hint";
  status.textContent = p.outdated
    ? "You've edited this prompt, and a newer default came with an app update. Your version is kept; "
      + "“Restore the default” switches to the new one (your edits would be lost)."
    : p.custom ? "Your own prompt (for a section you added)."
    : p.edited ? "You've edited this prompt." : "The built-in default.";
}

$("#ws-prompt").addEventListener("change", () => {
  if ($("#ws-prompt-text").value !== PROMPT_LOADED_TEXT
      && !confirm("Discard your unsaved changes to this prompt?")) {
    $("#ws-prompt").value = PROMPT_SHOWN;
    return;
  }
  say("#ws-prompt-result", "");
  showPrompt($("#ws-prompt").value);
});

$("#ws-save-prompt").addEventListener("click", async () => {
  try {
    SETTINGS = await api("/api/web/prompt", { method: "POST", json: { name: PROMPT_SHOWN, text: $("#ws-prompt-text").value } });
    showPromptList(PROMPT_SHOWN);
    say("#ws-prompt-result", "Saved. It applies to the next section you generate.");
  } catch (e) {
    say("#ws-prompt-result", e.message, true);
  }
});

$("#ws-restore-prompt").addEventListener("click", async () => {
  if (!confirm(`Replace your version of ${PROMPT_SHOWN} with the built-in default? Your edits to it will be lost.`)) return;
  try {
    SETTINGS = await api("/api/web/prompt/restore", { method: "POST", json: { name: PROMPT_SHOWN } });
    showPromptList(PROMPT_SHOWN);
    say("#ws-prompt-result", "Restored the default.");
  } catch (e) {
    say("#ws-prompt-result", e.message, true);
  }
});

$("#ws-reset-all").addEventListener("click", async () => {
  if (!confirm("Restore every prompt and the section list to the built-in defaults? Your edits to them will be lost. "
    + "(Your Claude settings and saved packets are kept.)")) return;
  try {
    SETTINGS = await api("/api/web/reset", { method: "POST" });
    SECTIONS_DRAFT = SETTINGS.sections.map((s) => ({ ...s }));
    showSections();
    showPromptList(PROMPT_SHOWN);
    await window.loadSections?.();
    say("#ws-prompt-result", "Prompts and sections were reset to the defaults.");
  } catch (e) {
    say("#ws-prompt-result", e.message, true);
  }
});
