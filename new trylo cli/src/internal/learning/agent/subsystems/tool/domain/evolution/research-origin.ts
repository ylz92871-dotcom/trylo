import { contentHashOf } from "../../../../../control/hash.js";
import { isJsonValue, keysAre, recordOf } from "./parse.js";

/** A new research episode retains the original purse and immutable predecessor.
 * It is not acquisition approval, a user correction or authority to execute. */
export type ToolResearchOrigin = { readonly rootJobId: string; readonly rootPlanHash: string;
  readonly previousJobId: string; readonly previousResultRef: string; readonly supplementVersionId: string };

export type ToolResearchSupplement = { readonly type: "tool_research_supplement"; readonly schemaVersion: 1;
  readonly scope: string; readonly previousJobId: string; readonly previousResultRef: string; readonly createdAt: string;
  readonly reason: string; readonly materials: readonly { readonly ref: string; readonly contentHash: string; readonly text: string }[] };

const jobId = (value: unknown): value is string => typeof value === "string" && /^tool-learning_v1_[a-f0-9]{64}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const resultRef = (value: unknown, parent: string): value is string => typeof value === "string"
  && new RegExp(`^result:${parent}:[1-9][0-9]*$`).test(value);

export function decodeToolResearchOrigin(raw: unknown): ToolResearchOrigin | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["rootJobId", "rootPlanHash", "previousJobId", "previousResultRef", "supplementVersionId"])
    || !jobId(raw.rootJobId) || !digest(raw.rootPlanHash) || !jobId(raw.previousJobId)
    || !resultRef(raw.previousResultRef, raw.previousJobId) || typeof raw.supplementVersionId !== "string"
    || !/^tool-research-supplement_v1_[a-f0-9]{64}$/.test(raw.supplementVersionId)) return undefined;
  return { rootJobId: raw.rootJobId, rootPlanHash: raw.rootPlanHash, previousJobId: raw.previousJobId,
    previousResultRef: raw.previousResultRef, supplementVersionId: raw.supplementVersionId };
}

export function decodeToolResearchSupplement(raw: unknown): ToolResearchSupplement | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["type", "schemaVersion", "scope", "previousJobId", "previousResultRef", "createdAt", "reason", "materials"])
    || raw.type !== "tool_research_supplement" || raw.schemaVersion !== 1 || !text(raw.scope) || !jobId(raw.previousJobId)
    || !resultRef(raw.previousResultRef, raw.previousJobId) || !text(raw.createdAt) || !Number.isFinite(Date.parse(raw.createdAt))
    || !text(raw.reason) || !Array.isArray(raw.materials) || raw.materials.length === 0) return undefined;

  const materials: ToolResearchSupplement["materials"][number][] = [];

  for (const item of raw.materials) {
    if (!recordOf(item) || !keysAre(item, ["ref", "contentHash", "text"]) || !text(item.ref) || !text(item.text)
      || !digest(item.contentHash) || contentHashOf(item.text) !== item.contentHash) return undefined;
    materials.push({ ref: item.ref, text: item.text, contentHash: item.contentHash });
  }

  if (new Set(materials.map(item => item.ref)).size !== materials.length) return undefined;

  return { type: raw.type, schemaVersion: 1, scope: raw.scope, previousJobId: raw.previousJobId,
    previousResultRef: raw.previousResultRef, createdAt: raw.createdAt, reason: raw.reason, materials };
}

export function toolResearchSupplementId(value: ToolResearchSupplement): string {
  return `tool-research-supplement_v1_${contentHashOf(value)}`;
}
