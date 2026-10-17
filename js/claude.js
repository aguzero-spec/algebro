// Talks to Claude straight from the browser, with the teacher's own API key.
// The browser version of app/generate.py: same request, same friendly errors, same cost estimate.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class GenerationError extends Error {}

// Write one section (or revise one). Calls onText(fullTextSoFar) as Claude writes.
// Returns {markdown, model, usage, cost, warning}.
export async function generate({ apiKey, system, user, config, onText, signal }) {
  if (!apiKey) throw new GenerationError("No Claude API key is saved yet. Add one in Settings.");
  const model = config.model;
  const body = {
    model,
    max_tokens: Math.trunc(config.max_output_tokens || 50000),
    // The system prompt holds the outline, identical for every section of a packet:
    // caching it makes the later sections cheaper.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    stream: true, // keeps long answers from hitting network timeouts
  };
  const headers = baseHeaders(apiKey);
  if (config.effort) body.output_config = { effort: config.effort };
  if (config.refusal_fallback && !model.includes("haiku")) { // Haiku has no fallback
    headers["anthropic-beta"] = FALLBACK_BETA;
    body.fallbacks = "default";
  }
  if (config.temperature !== null && config.temperature !== undefined && config.temperature !== "") {
    body.temperature = Number(config.temperature); // only for older models; see config
  }

  const response = await send(headers, body, model, signal);
  const message = await readStream(response, onText, model);

  if (message.stop_reason === "refusal") {
    throw new GenerationError("Claude declined to write this section. Try rewording your lesson outline or notes, then try again.");
  }
  const markdown = message.text.trim();
  if (!markdown) throw new GenerationError("Claude returned an empty answer. Please try again.");
  const usage = {
    input_tokens: message.usage.input_tokens || 0,
    output_tokens: message.usage.output_tokens || 0,
    cache_write_tokens: message.usage.cache_creation_input_tokens || 0,
    cache_read_tokens: message.usage.cache_read_input_tokens || 0,
  };
  return {
    markdown,
    model: message.model, // differs from config if a refusal fallback model took over
    usage,
    cost: estimateCost(usage, message.model, config),
    warning: message.stop_reason === "max_tokens"
      ? "This section was cut off because it reached the length limit. Raise the length limit in Settings, then regenerate it."
      : "",
  };
}

// A tiny call (costs a small fraction of a cent) to check a key works.
// Returns "" if all is well, or a warning if the key is valid but can't be used yet (e.g. no credits).
export async function testKey(apiKey, config) {
  try {
    const response = await send(baseHeaders(apiKey), {
      model: config.model, max_tokens: 16, output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with: OK" }],
    }, config.model);
    await response.json();
    return "";
  } catch (e) {
    // The key itself is fine if Claude only complained about the account (credits, limits).
    if (e instanceof GenerationError && [400, 429].includes(e.status)) return e.message;
    throw e;
  }
}

function baseHeaders(apiKey) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // Required for calls from a web page. Fine here: each teacher uses their own key.
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  };
}

// Send the request, retrying twice if Claude is busy (like the desktop app does).
async function send(headers, body, model, signal) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new GenerationError("Couldn't reach Claude. Check your internet connection and try again.");
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 2) {
      const wait = Number(response.headers.get("retry-after")) || 2 ** attempt * 2;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 20) * 1000));
      continue;
    }
    const detail = await response.json().catch(() => ({}));
    throw friendlyError(response.status, detail?.error?.message || response.statusText, model);
  }
}

// Turn Claude's errors into messages a teacher can act on (same wording as the desktop app).
function friendlyError(status, message, model) {
  const text = {
    401: "Your Claude API key was rejected. It may be mistyped, incomplete, or deleted. Copy it again from "
       + "platform.claude.com (API Keys) and paste it in Settings.",
    403: `Your API key isn't allowed to do this: ${message}`,
    404: `The model “${model}” wasn't found. Check the model name in Settings.`,
    429: "Your Claude account's rate limit or monthly spend limit was reached. Wait a minute and try again, "
       + "or check Settings > Limits at platform.claude.com.",
    400: `Claude couldn't accept the request: ${message}`, // includes "credit balance is too low"
  }[status] || (status >= 500
    ? "Claude's servers are busy or having trouble. Wait a moment and try again."
    : `Claude returned an error (${status}): ${message}`);
  const error = new GenerationError(text);
  error.status = status;
  return error;
}

// Read Claude's streamed answer ("server-sent events"), collecting the text and token counts.
async function readStream(response, onText, model) {
  const message = { text: "", model, stop_reason: null, usage: {} };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) handleEvent(JSON.parse(data), message, onText);
    }
  }
  if (!message.stop_reason) {
    throw new GenerationError("The connection to Claude was interrupted before the section was finished. Please try again.");
  }
  return message;
}

function handleEvent(event, message, onText) {
  switch (event.type) {
    case "message_start":
      message.model = event.message.model || message.model;
      Object.assign(message.usage, event.message.usage);
      break;
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        message.text += event.delta.text;
        onText?.(message.text);
      }
      break;
    case "message_delta":
      message.stop_reason = event.delta.stop_reason ?? message.stop_reason;
      for (const [key, value] of Object.entries(event.usage || {})) {
        if (value !== null && value !== undefined) message.usage[key] = value;
      }
      break;
    case "error":
      throw friendlyError(event.error?.type === "overloaded_error" ? 529 : 500, event.error?.message || "", message.model);
  }
}

// Rough cost in US dollars, from the prices in the settings. null if the model has no price listed.
export function estimateCost(usage, model, config) {
  const price = (config.prices || {})[model];
  const perIn = Number(price?.input) / 1e6;
  const perOut = Number(price?.output) / 1e6;
  if (!Number.isFinite(perIn) || !Number.isFinite(perOut)) return null;
  const cost = usage.input_tokens * perIn
    + usage.cache_write_tokens * perIn * 1.25 // writing to the cache costs a bit more
    + usage.cache_read_tokens * perIn * 0.10  // reading from it costs much less
    + usage.output_tokens * perOut;
  return Math.round(cost * 1e4) / 1e4;
}
