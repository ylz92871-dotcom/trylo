import { classifyBudgetRejection } from "../../domain/provider-budget-rejection.js";
import type { ProviderErrorClass } from "../../ports/provider.js";
import { classifyHttpStatus } from "./http-status.js";
import { quotaFailureMessage } from "./quota-failure.js";

const MAX_ERROR_BYTES = 8192;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticMessage(text: string, errorClass: ProviderErrorClass): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed)) return undefined;
    if (errorClass === "rate_limit") return quotaFailureMessage(parsed);
    const error = object(parsed.error) ? parsed.error : parsed;
    const fields = [error.code, error.type, error.message].filter((value): value is string => typeof value === "string");
    const rejection = classifyBudgetRejection("invalid_request", fields.join(" "));
    if (rejection?.kind === "prompt_too_long") return "prompt is too long";
    if (rejection?.kind === "media_too_large") return "media is too large";
    return undefined;
  } catch {
    // Unknown diagnostics never escape the adapter or change its HTTP failure.
    return undefined;
  }
}

/** Inspect only bounded invalid-request/429 diagnostics. Return fixed vocabulary,
 * never provider prose (which may echo prompts or credentials). A slow or
 * unreadable error body keeps the original status after a bounded wait.
 */
export async function httpFailureMessage(
  response: Response,
  errorClass: ProviderErrorClass,
  signal: AbortSignal,
  options: { readonly timeoutSignal?: AbortSignal } = {},
): Promise<string> {
  const fallback = `http_${response.status}`;
  if (response.body === null) return fallback;
  const reader = response.body.getReader();
  const diagnosticSignal = AbortSignal.any([signal, options.timeoutSignal ?? AbortSignal.timeout(1000)]);
  const cancel = (): void => { void reader.cancel().catch(() => { /* Cleanup cannot replace the classified HTTP failure. */ }); };
  diagnosticSignal.addEventListener("abort", cancel, { once: true });
  try {
    if ((errorClass !== "invalid_request" && errorClass !== "rate_limit") || diagnosticSignal.aborted) return fallback;
    const decoder = new TextDecoder();
    let bytes = 0, text = "";
    for (;;) {
      const step = await reader.read();
      if (diagnosticSignal.aborted) return fallback;
      if (step.done) return diagnosticMessage(text + decoder.decode(), errorClass) ?? fallback;
      bytes += step.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return fallback;
      text += decoder.decode(step.value, { stream: true });
    }
  } catch {
    // Transport/JSON diagnostics are optional; the HTTP status remains known.
    return fallback;
  } finally {
    diagnosticSignal.removeEventListener("abort", cancel);
    // Starting cancellation closes the reader synchronously. Its underlying
    // transport cleanup may never settle and cannot delay a known HTTP failure.
    void reader.cancel().catch(() => { /* Optional diagnostic cleanup cannot replace the classified failure. */ });
    reader.releaseLock();
  }
}

/** Status plus bounded structured diagnostics decide one canonical failure. */
export async function classifyHttpFailure(response: Response, signal: AbortSignal): Promise<{ readonly class: ProviderErrorClass; readonly message: string }> {
  const initial = classifyHttpStatus(response.status);
  const message = await httpFailureMessage(response, initial, signal);
  return { class: message === "quota_exceeded" || message.startsWith("quota_exceeded; ") ? "quota" : initial, message };
}
