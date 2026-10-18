// Starts the web version: connects the shared interface (app.js, the same one the desktop
// apps use) to local_api.js instead of a server, then loads the interface.

import { backupFile, download, handle, loadDefaults, restoreBackup, usageCsv } from "./local_api.js?v=915ff20897";

// Refuse to run inside another website's frame (a look-alike page could trick clicks;
// GitHub Pages can't send the header that normally prevents this).
if (window.top !== window.self) {
  document.body.replaceChildren(Object.assign(document.createElement("p"), {
    className: "banner error",
    textContent: "For your security, Lesson Packet Builder only runs in its own tab. Open aguzero-spec.github.io/algebro directly.",
  }));
  throw new Error("Framed: not starting.");
}

// Browsers older than about 2023 lack features the app needs: say so instead of half-working.
function browserProblem() {
  try {
    new RegExp("(?<![\\p{L}])x", "u"); // lookbehind + Unicode letters (Safari 16.4+)
  } catch {
    return true;
  }
  return typeof structuredClone !== "function" || typeof TextDecoderStream !== "function"
    || typeof indexedDB === "undefined" || !window.crypto?.subtle;
}
if (browserProblem()) {
  const banner = document.querySelector("#error-banner");
  banner.textContent = "This browser is too old for Lesson Packet Builder. Update it, or use a current version of "
    + "Chrome, Edge, Safari, or Firefox (on a Chromebook, update ChromeOS).";
  banner.hidden = false;
  throw new Error("Unsupported browser.");
}

window.LOCAL_API = handle;

// Warn before the tab closes (or reloads) with unsaved changes.
let unsaved = false;
window.onUnsavedChange = (value) => { unsaved = value; };
window.addEventListener("beforeunload", (event) => {
  if (unsaved) event.preventDefault();
});

// Load the shared interface scripts in order (they're plain scripts, not modules).
function loadClassic(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Couldn't load ${src}.`));
    document.body.appendChild(script);
  });
}

const build = document.documentElement.dataset.build || ""; // this build's fingerprint (see scripts/build_web.py)
try {
  await loadDefaults();
  await loadClassic(`js/markdown.js?v=${build}`);
  await loadClassic(`js/app.js?v=${build}`);
  const { startSettingsEditors } = await import("./settings_ui.js?v=915ff20897");
  await startSettingsEditors();
} catch (e) {
  const banner = document.querySelector("#error-banner");
  banner.textContent = `The app couldn't start: ${e.message} Check your internet connection and reload the page.`;
  banner.hidden = false;
}

// ---- Backups (Settings › Your saved packets) ----

const $ = (selector) => document.querySelector(selector);
const say = (text, error = false) => {
  $("#backup-result").textContent = text;
  $("#backup-result").className = error ? "hint inline-error" : "hint";
};

$("#backup-download").addEventListener("click", async () => {
  try {
    const { blob, filename, count } = await backupFile();
    if (!count) {
      say("There are no saved packets to back up yet.");
      return;
    }
    download(blob, filename);
    say(`Downloaded “${filename}” with ${count} packet${count === 1 ? "" : "s"}. Keep it somewhere safe.`);
  } catch (e) {
    say(e.message, true);
  }
});

$("#backup-restore").addEventListener("click", () => $("#backup-file").click());
$("#backup-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) {
    say(`“${file.name}” is too large to be a backup.`, true);
    return;
  }
  try {
    const { added, updated, skipped } = await restoreBackup(await file.text());
    const parts = [`${added} added`, `${updated} updated with a newer copy`];
    if (skipped) parts.push(`${skipped} skipped (already here, or not a packet)`);
    say(`Restored from “${file.name}”: ${parts.join(", ")}. See the Saved page.`);
  } catch (e) {
    say(e.message, true);
  }
});

// ---- Usage page: start the count over (records are kept), and download every record ----

document.querySelector("#usage-reset").addEventListener("click", async () => {
  if (!confirm("Start the totals over from now? Every record stays in “All records” (and in the download). "
    + "This only changes the estimates shown here; your actual bill at platform.claude.com isn't affected.")) return;
  try {
    await handle("/api/usage/reset", { method: "POST" });
    await window.loadUsage?.();
  } catch (e) {
    const banner = document.querySelector("#error-banner");
    banner.textContent = e.message;
    banner.hidden = false;
  }
});

document.querySelector("#usage-download").addEventListener("click", async () => {
  try {
    const { blob, filename, count } = await usageCsv();
    if (!count) return;
    download(blob, filename);
  } catch (e) {
    const banner = document.querySelector("#error-banner");
    banner.textContent = e.message;
    banner.hidden = false;
  }
});
