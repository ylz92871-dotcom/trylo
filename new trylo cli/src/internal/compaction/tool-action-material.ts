import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { scrubDisclosure } from "./disclosure.js";

type ToolCallItem = Extract<TranscriptItem, { readonly kind: "tool_call" }>;

/** Explicit credential containers, not substring matches: author, tokenizer,
 * tokenBudget and token_count are ordinary public arguments. Environment and
 * headers can contain host-injected secrets, even with otherwise public names.
 */
const PRIVATE_FIELDS = new Set([
  "env", "environment", "auth", "authentication", "authorization", "credential", "credentials",
  "password", "passwd", "secret", "secrets", "apikey", "accesskey", "secretkey", "privatekey",
  "clientsecret", "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "bearer",
  "cookie", "cookies", "setcookie", "header", "headers",
]);

/** Both summary authors see the same public executed arguments. Source fields
 * precede an arbitrarily large body so the bounded extractive line can still
 * identify the action's target. The model material keeps the complete body.
 */
export function toolActionMaterial(item: ToolCallItem): string {
  const args = publicObject(item.arguments);
  const source = ["path", "cwd", "action"].flatMap(key => {
    const value = args[key];
    return typeof value === "string" ? [`${key} ${JSON.stringify(value)}`] : [];
  });

  if (item.name === "read_file") {
    for (const key of ["offset", "limit"]) {
      const value = args[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) source.push(`${key} ${value}`);
    }
  }

  return (source.length === 0 ? "" : " " + source.join(" ")) + " arguments " + JSON.stringify(args);
}

export function privateSummaryField(key: string): boolean {
  return PRIVATE_FIELDS.has(key.replace(/[-_\s]/g, "").toLowerCase());
}

function privateOption(value: JsonValue | undefined): boolean {
  if (typeof value !== "string") return false;
  const key = /^-{1,2}([\w-]+)$/.exec(value)?.[1];
  return key !== undefined && privateSummaryField(key);
}

function publicObject(value: object): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, child]): [string, JsonValue] =>
    [scrubDisclosure(key), privateSummaryField(key) ? "[secret]" : publicSummaryValue(child)]));
}

/** The same structural disclosure boundary for action arguments and observed JSON. */
export function publicSummaryValue(value: unknown): JsonValue {
  if (typeof value === "string") return scrubDisclosure(value);
  if (Array.isArray(value)) {
    return value.map((child, index) => privateOption(value[index - 1]) ? "[secret]" : publicSummaryValue(child));
  }
  if (value !== null && typeof value === "object") return publicObject(value);
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  return "[unsupported value]";
}
