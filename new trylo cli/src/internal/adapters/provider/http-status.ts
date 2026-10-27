import type { ProviderErrorClass } from "../../ports/provider.js";

export function classifyHttpStatus(status: number): ProviderErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500) return "server";
  return "unknown";
}
