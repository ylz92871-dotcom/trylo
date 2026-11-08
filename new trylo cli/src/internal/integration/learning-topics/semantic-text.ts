import { text as boundedText } from "../../validation/json-shape.js";

/** User/host event projectors retain their original admission ceiling. */
export function isTopicSemanticText(value: unknown): value is string {
  return boundedText(value, 256) && Buffer.byteLength(value, "utf8") <= 1024;
}

/** Only the closed comparison reader may use this larger text envelope. */
export function isBoundedTopicComparisonText(value: unknown): value is string {
  return boundedText(value, 512) && Buffer.byteLength(value, "utf8") <= 1024;
}
