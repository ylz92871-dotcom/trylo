import type { JsonValue } from "../../../../../../protocol/envelope.js";
import { TOOL_EVOLUTION_MAX_JSON_DEPTH } from "./contracts.js";
import { isJsonData } from "../../../../../../tooling/contract/json-value.js";

export { recordOf, keysAre, textOf, isDigest, utf8Bytes, jsonBytes } from "../../../../../../tooling/contract/json-value.js";

/** Finite numbers, plain data objects and dense arrays; no accessors or hidden members. */
export function isJsonValue(value: unknown, maxDepth = TOOL_EVOLUTION_MAX_JSON_DEPTH): value is JsonValue {
  return isJsonData(value, maxDepth);
}
