// Phase 0 test page: writes one lesson plan in the browser, to prove the connection to Claude.
import { generate } from "./claude.js";
import { build } from "./prompts.js";

const $ = (selector) => document.querySelector(selector);

// Load the same defaults the desktop app uses (prompts, sections, settings, TEKS/ELPS).
async function loadDefaults() {
  const get = async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Couldn't load ${path} (${response.status}).`);
    return response.json();
  };
  const [defaults, math, elps] = await Promise.all([
    get("data/defaults.json"), get("data/tx_math_6_8.json"), get("data/tx_elps_4_12.json")]);
  return { ...defaults, standards: { math, elps } };
}

const defaultsReady = loadDefaults();

// The key lives only in this tab (sessionStorage): closing the tab forgets it.
try { $("#api-key").value = sessionStorage.getItem("api-key") || ""; } catch { /* storage blocked */ }
$("#api-key").addEventListener("input", () => {
  try { sessionStorage.setItem("api-key", $("#api-key").value.trim()); } catch { /* storage blocked */ }
});

let controller = null;

$("#proof-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const options = {
    seed: $("#seed").value, grade_level: $("#grade").value, subject: $("#subject").value,
    topic: $("#topic").value, standards: "", teks: [], elps: false, spanish: false,
    num_days: Number($("#days").value) || 1, class_minutes: Number($("#minutes").value) || 50, notes: "",
  };
  const missing = [["seed", "your lesson outline"], ["grade_level", "grade level"], ["subject", "subject"], ["topic", "topic"]]
    .find(([field]) => !options[field].trim());
  $("#status").textContent = missing ? `Please fill in: ${missing[1]}.` : "";
  if (missing) return;

  $("#result-card").hidden = false;
  $("#error").hidden = true;
  $("#result").textContent = "";
  $("#details").textContent = "";
  $("#go").disabled = true;
  $("#stop").hidden = false;
  $("#status").textContent = "Writing… (about a minute)";
  controller = new AbortController();
  const started = performance.now();
  try {
    const defaults = await defaultsReady;
    const section = defaults.sections.find((s) => s.id === "lesson_plan");
    const { system, user } = build({ section, options, prompts: defaults.prompts, standards: defaults.standards });
    const result = await generate({
      apiKey: $("#api-key").value.trim(), system, user, config: defaults.config, signal: controller.signal,
      onText: (text) => { $("#result").textContent = text; }, // plain text: nothing Claude writes can run as code
    });
    $("#result").textContent = result.markdown;
    const u = result.usage;
    $("#details").textContent = `${result.model} · ${u.input_tokens.toLocaleString()} tokens in`
      + ` (+${u.cache_write_tokens.toLocaleString()} cache write, ${u.cache_read_tokens.toLocaleString()} cache read)`
      + ` · ${u.output_tokens.toLocaleString()} out · about $${(result.cost ?? 0).toFixed(2)}`
      + ` · ${Math.round((performance.now() - started) / 1000)} s` + (result.warning ? ` · ${result.warning}` : "");
    $("#status").textContent = "Done.";
  } catch (e) {
    $("#error").textContent = e.name === "AbortError" ? "Stopped." : e.message;
    $("#error").hidden = false;
    $("#status").textContent = "";
  } finally {
    $("#go").disabled = false;
    $("#stop").hidden = true;
    controller = null;
  }
});

$("#stop").addEventListener("click", () => controller?.abort());
