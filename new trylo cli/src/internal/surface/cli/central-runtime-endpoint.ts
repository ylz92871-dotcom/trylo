import { normalizeChatEndpoint } from "./connection-endpoint.js";
import { text } from "../../validation/json-shape.js";

/** Persist only the explicitly selected public address. Unknown query data
 * needs an original named provider; it is never stripped into a new target. */
export function isPublicCentralRuntimeEndpoint(value: unknown, secret?: string): value is string {
  if (!text(value, 8192) || value !== value.trim() || !normalizeChatEndpoint(value, "endpoint").ok) return false;
  const url = new URL(value);
  if (url.hash !== "" || url.search !== "") return false;
  return !secret || !value.includes(secret) && !value.includes(encodeURIComponent(secret));
}
