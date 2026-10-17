// Builds the text sent to Claude from the prompt templates and the teacher's options.
// The browser version of app/prompts.py and app/standards.py: keep them in step.

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const SYSTEM_PROMPT_FILE = "system.txt";
const REVISE_PROMPT_FILE = "revise.txt"; // used by the "Revise" button (edit the current text)

const TEXAS_BLOCKS = {
  teks: "TEKS (official wording)",
  elps: "Emergent bilingual students (ELPS)",
  spanish: "Spanish support",
};

// Replace {{name}} with values[name]. Unknown names are left as typed, so typos stay visible.
export function fill(template, values) {
  return template.replace(PLACEHOLDER, (match, name) => {
    if (!(name in values)) return match;
    const value = values[name];
    return value === null || value === undefined || value === "" ? "(not specified)" : String(value);
  });
}

// The official wording of the chosen TEKS, as one block for the prompt.
export function describeTeks(codes, math) {
  if (!codes.length) return "";
  const found = {};
  for (const course of math.courses) {
    for (const strand of course.strands) {
      for (const e of strand.expectations) {
        if (codes.includes(e.code)) found[e.code] = [course, strand, e];
      }
    }
  }
  return codes.map((code) => {
    if (!found[code]) return `- ${code} (not found in the built-in TEKS list; treat as the teacher's note)`;
    const [course, strand, e] = found[code];
    return `- TEKS ${code} (${course.name}, ${strand.title}): ${e.text}`;
  }).join("\n");
}

// The ELPS cross-curricular student expectations (grades 4-12), for the prompt.
export function describeElps(elps) {
  const lines = [`${elps.title} (${elps.section}), in effect from the ${elps.applies_from}. `
    + `Proficiency levels: ${elps.levels.join(", ")}.`];
  for (const domain of elps.domains) {
    lines.push(`${domain.title}:`);
    for (const e of domain.expectations) lines.push(`- ${e.code}: ${e.text}`);
  }
  return lines.join("\n");
}

// Text for the {{teks}}, {{elps}}, and {{spanish}} placeholders, from the form's choices.
export function texasValues(options, standards) {
  const teks = describeTeks(options.teks || [], standards.math);
  const elps = options.elps
    ? "The class includes emergent bilingual (EB) students. Build ELPS-aligned language supports into "
      + "every section, plan for the students' proficiency levels, and cite ELPS only from this official "
      + 'list, by code (for example "ELPS L.B"):\n' + describeElps(standards.elps)
    : "Not requested.";
  const spanish = options.spanish
    ? "Requested. The class includes Spanish speakers. Where the section's instructions mention Spanish "
      + "support, add it in clear, standard Spanish as used in Texas schools. Keep all math notation unchanged."
    : "Not requested: write in English.";
  return { teks: teks || "None selected.", elps, spanish };
}

function readPrompt(prompts, filename) {
  if (!(filename in prompts)) {
    throw new Error(`Prompt file “${filename}” is missing. Use Settings › Reset prompts to defaults.`);
  }
  return prompts[filename];
}

// Return {system, user} for one section.
// Normally the section is written from scratch, following extraInstructions (the section's
// saved instructions). If currentText is given, Claude instead revises that text, changing
// only what extraInstructions asks for. followText is the section this one follows (e.g. the slides).
export function build({ section, options, lessonPlan = "", extraInstructions = "", currentText = "",
                        followText = "", prompts, standards }) {
  const values = { ...options };
  values.lesson_plan = lessonPlan || "(No lesson plan was generated. Base this on the teacher's lesson outline.)";
  Object.assign(values, texasValues(options, standards));
  if (section.follows) { // e.g. Student Notes are built from the slides: {{slides}}
    values[section.follows] = followText.trim()
      || `(The ${section.follows.replaceAll("_", " ")} section hasn't been written. Base this on the lesson plan below.)`
         + `\n\n${values.lesson_plan}`;
  }
  const template = readPrompt(prompts, SYSTEM_PROMPT_FILE);
  let system = fill(template, values);
  // A teacher's own system prompt may predate these placeholders: add the blocks at the end.
  for (const [key, heading] of Object.entries(TEXAS_BLOCKS)) {
    if (!template.includes(`{{${key}}}`) && options[key] && (key !== "teks" || options.teks.length)) {
      system += `\n\n## ${heading}\n${values[key]}`;
    }
  }

  if (currentText) {
    Object.assign(values, { section_name: section.name, current_section: currentText,
                            change_request: extraInstructions.trim() });
    return { system, user: fill(readPrompt(prompts, REVISE_PROMPT_FILE), values) };
  }
  let user = fill(readPrompt(prompts, section.prompt_file), values);
  if (extraInstructions.trim()) {
    user += `\n\nAdditional instructions from the teacher for this section:\n${extraInstructions.trim()}`;
  }
  return { system, user };
}
