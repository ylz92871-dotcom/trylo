import { contentHashOf } from "../../../../../control/hash.js";
import { keysAre, recordOf, textOf } from "../evolution/parse.js";

/** Exact host user channel, never an assistant's restatement or observed answer. */
export type ToolTaskText = { readonly turnId: string; readonly reference: string; readonly contentHash: string;
  readonly originalChars: number; readonly originalBytes: number; readonly text: string; readonly excerptHash: string; readonly partial: boolean };

export function captureToolTaskText(turnId: string, text: string): ToolTaskText | undefined {
  if (!textOf(turnId, 160) || typeof text !== "string" || text.trim().length === 0) return undefined;

  let excerpt = "", excerptBytes = 0;

  for (const point of text) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (excerpt.length + point.length > 4_000 || excerptBytes + bytes > 8_192) break;
    excerpt += point;
    excerptBytes += bytes;
  }

  const contentHash = contentHashOf(text);

  return { turnId, reference: referenceFor(turnId, contentHash), contentHash, originalChars: text.length,
    originalBytes: Buffer.byteLength(text, "utf8"), text: excerpt, excerptHash: contentHashOf(excerpt), partial: excerpt !== text };
}

export function decodeToolTaskText(raw: unknown): ToolTaskText | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["turnId", "reference", "contentHash", "originalChars", "originalBytes", "text", "excerptHash", "partial"])
    || !textOf(raw.turnId, 160) || !textOf(raw.reference, 160) || !digest(raw.contentHash) || !digest(raw.excerptHash)
    || typeof raw.text !== "string" || raw.text.length === 0 || raw.text.length > 4_000 || Buffer.byteLength(raw.text, "utf8") > 8_192
    || !positiveInteger(raw.originalChars) || !positiveInteger(raw.originalBytes) || typeof raw.partial !== "boolean"
    || raw.reference !== referenceFor(raw.turnId, raw.contentHash) || raw.excerptHash !== contentHashOf(raw.text)) return undefined;

  const bytes = Buffer.byteLength(raw.text, "utf8");
  if (raw.partial ? raw.originalChars <= raw.text.length || raw.originalBytes <= bytes
    : raw.originalChars !== raw.text.length || raw.originalBytes !== bytes || raw.contentHash !== contentHashOf(raw.text)) return undefined;

  return { turnId: raw.turnId, reference: raw.reference, contentHash: raw.contentHash, originalChars: raw.originalChars,
    originalBytes: raw.originalBytes, text: raw.text, excerptHash: raw.excerptHash, partial: raw.partial };
}

/** A bounded excerpt is an independent textual requirement, not a complete
 * specification or an observed expected value. Never fill omitted constraints. */
export function toolTaskTextRequirements(plan: { readonly trigger: { readonly runId: string };
  readonly opportunity?: { readonly task?: ToolTaskText } }): readonly { readonly ref: string; readonly kind: "user_requirement"; readonly text: string }[] {
  const task = decodeToolTaskText(plan.opportunity?.task);
  return task === undefined || task.turnId !== plan.trigger.runId ? [] : [{ ref: task.reference, kind: "user_requirement",
    text: `Host-bound original user task; partial=${task.partial}; fullTextHash=${task.contentHash}; originalChars=${task.originalChars}; originalBytes=${task.originalBytes}. `
      + "This is task text, not observed input/output or authority. Do not invent omitted requirements; defer if the visible task is not checkable.\n" + task.text }];
}

function referenceFor(turnId: string, contentHash: string): string { return `user-task:${contentHashOf([turnId, contentHash])}`; }

function digest(raw: unknown): raw is string { return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw); }

function positiveInteger(raw: unknown): raw is number { return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0; }
