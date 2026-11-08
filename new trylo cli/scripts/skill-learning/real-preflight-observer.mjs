import { scrubDisclosure } from "../../dist/internal/compaction/disclosure.js";

// Child-only connection telemetry. Never records headers, credentials, prompts,
// raw response bodies or reasoning; a second actual HTTP request is refused.
const originalFetch = globalThis.fetch;
const state = { networkRequests: 0, blockedRetries: 0, statuses: [], failures: [], errorHints: [], errorDetails: [], maxOutputTokens: null, advertisedTools: null };
const hints = ["InvalidSubscription", "insufficient_quota", "invalid_api_key", "model_not_found", "rate_limit_exceeded", "subscription_required"];

globalThis.fetch = async (url, options = {}) => {
  if (state.networkRequests >= 1) {
    state.blockedRetries += 1;
    throw new Error("preflight_network_request_limit");
  }

  state.networkRequests += 1;

  try {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    state.maxOutputTokens = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? null;
    state.advertisedTools = Array.isArray(body?.tools) ? body.tools.length : 0;
  } catch { /* Metadata is optional; malformed request content is never printed. */ }

  let response;

  try { response = await originalFetch(url, { ...options, redirect: "error" }); }
  catch (error) {
    // Node transport codes distinguish DNS/TLS/socket failures without leaking
    // endpoint strings, credentials or raw OS/provider messages.
    const codes = [error?.code, error?.cause?.code].filter(code => typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code));
    state.failures.push({ codes: [...new Set(codes)], name: ["Error", "TypeError", "AbortError", "TimeoutError"].includes(error?.name) ? error.name : "unknown" });
    throw error;
  }

  state.statuses.push(response.status);

  if (!response.ok) {
    try {
      const body = await response.clone().text();
      state.errorHints.push(...hints.filter(hint => body.includes(hint)));
      state.errorDetails.push(safeProviderError(body));
    } catch { /* An unreadable failure body remains an HTTP status, never fabricated detail. */ }
  }

  return response;
};

process.once("exit", () => process.stderr.write(`TRYLO_REAL_PREFLIGHT_TELEMETRY ${JSON.stringify(state)}\n`));

function safeProviderError(body) {
  let value;

  try { value = JSON.parse(body); }
  catch { return { format: "non_json", bodyChars: body.length }; }

  const nested = value?.error;
  const error = nested !== null && typeof nested === "object" ? nested : value;

  return { format: "json", code: safeField(error?.code), type: safeField(error?.type),
    message: safeField(typeof nested === "string" ? nested : error?.message) };
}

function safeField(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let text = String(value);
  const secret = process.env.TRYLO_OPENAI_API_KEY;
  if (typeof secret === "string" && secret.length > 0) text = text.replaceAll(secret, "[secret]");
  return scrubDisclosure(text).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [secret]").slice(0, 2048);
}
