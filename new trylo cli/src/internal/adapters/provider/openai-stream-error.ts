import type { ProviderErrorClass, ProviderEvent } from "../../ports/provider.js";
import { classifyHttpStatus } from "./http-status.js";
import { quotaFailureMessage } from "./quota-failure.js";

const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A gateway can fail inside HTTP 200 SSE. Classify only structured metadata;
 * messages/details may contain private upstream bodies and never leave here.
 */
export function openAiStreamError(error: unknown): Extract<ProviderEvent, { type: "error" }> | undefined {
  if (error === undefined || error === null) return undefined;
  const quota = quotaFailureMessage(error);
  if (quota !== undefined) return { type: "error", class: "quota", retryable: false, phase: "after_stream_started", message: quota };
  const info = row(error) ? error : {};
  const details = row(info.details) ? info.details : {};
  const candidate = info.status ?? info.status_code ?? details.statusCode;
  const status = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate < 600
    ? candidate : undefined;
  const codes = [info.type, info.code].filter((value): value is string => typeof value === "string").map(value => value.toLowerCase());
  let classification: ProviderErrorClass = status === undefined ? "unknown" : classifyHttpStatus(status);
  if (classification === "unknown") {
    if (codes.some(code => ["invalid_api_key", "authentication_error", "permission_error"].includes(code))) classification = "auth";
    else if (codes.some(code => ["rate_limit_error", "rate_limit_exceeded"].includes(code))) classification = "rate_limit";
    else if (codes.some(code => ["invalid_request_error", "invalid_request"].includes(code))) classification = "invalid_request";
    else if (codes.some(code => ["gateway_error", "server_error", "streaming_error", "overloaded_error"].includes(code))) classification = "server";
    else if (status === 408 || codes.some(code => ["timeout", "timeout_error"].includes(code))) classification = "timeout";
  }
  return { type: "error", class: classification, retryable: false, phase: "after_stream_started",
    message: `provider_stream_${classification}_error` };
}
