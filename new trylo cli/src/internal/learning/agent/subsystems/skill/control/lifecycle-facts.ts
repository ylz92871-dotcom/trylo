import { fields, identity, sequence, text } from "../../../../../validation/json-shape.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { RewardV2Draft, RewardV2Fact } from "../../../../reward/v2-facts.js";

export const SKILL_LIFECYCLE_VERSION = "hermes-source-lifecycle/v1";

export type SkillLifecycleBinding = {
  readonly issueId: string; readonly grantId: string; readonly jobId: string; readonly pendingRef: string;
};

export type SkillApprovalObservation = SkillLifecycleBinding & {
  readonly schemaVersion: 1; readonly kind: "native_approved"; readonly at: string;
  readonly payloadHash: string; readonly action: "create" | "edit" | "patch" | "write_file" | "remove_file";
  readonly name: string; readonly instructionHash: string | null;
};

export type SkillLoadObservation = SkillLifecycleBinding & {
  readonly schemaVersion: 1; readonly kind: "instruction_loaded"; readonly at: string;
  readonly approvalRef: string; readonly name: string; readonly instructionHash: string; readonly renderedContentHash: string;
  readonly sessionId: string; readonly turnId: string; readonly toolCallId: string;
  readonly transcriptSequence: number; readonly journalSequence: number;
};

export type SkillLifecycleObservation = SkillApprovalObservation | SkillLoadObservation;

export type SkillLifecycleFact = { readonly fact: RewardV2Fact; readonly observation: SkillLifecycleObservation };

const BINDING_KEYS: readonly (keyof SkillLifecycleBinding)[] = ["issueId", "grantId", "jobId", "pendingRef"];
const BASE_KEYS = [...BINDING_KEYS, "schemaVersion", "kind", "at", "name", "instructionHash"];
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An additive domain-owned payload in the existing opaque RewardV2 extension.
 * An absent v1 payload in older Boards means unknown, never a negative outcome. */
export function isSkillLifecycleObservation(value: unknown): value is SkillLifecycleObservation {
  if (!record(value)) return false;

  const approved = value.kind === "native_approved";
  const keys = approved ? [...BASE_KEYS, "payloadHash", "action"]
    : [...BASE_KEYS, "approvalRef", "renderedContentHash", "sessionId", "turnId", "toolCallId", "transcriptSequence", "journalSequence"];
  if (!fields(value, keys) || value.schemaVersion !== 1 || !instant(value.at) || !text(value.name, 512)
    || !BINDING_KEYS.every(key => identity(value[key])) || typeof value.pendingRef !== "string"
    || !value.pendingRef.startsWith("hermes-pending:skills:") || value.pendingRef.length <= "hermes-pending:skills:".length) return false;

  if (approved) return typeof value.payloadHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.payloadHash)
    && ["create", "edit", "patch", "write_file", "remove_file"].includes(String(value.action))
    && (value.instructionHash === null || hash(value.instructionHash) && ["create", "edit", "patch"].includes(String(value.action)));

  return value.kind === "instruction_loaded" && hash(value.instructionHash) && hash(value.renderedContentHash)
    && [value.approvalRef, value.sessionId, value.turnId, value.toolCallId].every(identity)
    && sequence(value.transcriptSequence) && sequence(value.journalSequence);
}

export function skillLifecycleDraft(scope: string, observation: SkillLifecycleObservation): RewardV2Draft | undefined {
  if (!identity(scope) || !isSkillLifecycleObservation(observation)) return undefined;
  return { id: `hermes-lifecycle:${contentHashOf([scope, observation])}`, scope, algorithmVersion: SKILL_LIFECYCLE_VERSION,
    kind: "feedback", payloadJson: JSON.stringify(observation) };
}

export function readSkillLifecycleFacts(facts: readonly RewardV2Fact[], scope: string):
  { readonly status: "ready"; readonly records: readonly SkillLifecycleFact[] } | { readonly status: "invalid"; readonly reason: string } {
  const records: SkillLifecycleFact[] = [];

  for (const fact of facts) {
    if (fact.scope !== scope || fact.algorithmVersion !== SKILL_LIFECYCLE_VERSION) continue;

    let raw: unknown;

    try { raw = JSON.parse(fact.payloadJson); }
    catch { return { status: "invalid", reason: "hermes_lifecycle_payload" }; }

    if (!isSkillLifecycleObservation(raw)) return { status: "invalid", reason: "hermes_lifecycle_payload" };

    const expected = skillLifecycleDraft(scope, raw);
    if (expected?.id !== fact.id || fact.kind !== "feedback") return { status: "invalid", reason: "hermes_lifecycle_identity" };

    if (raw.kind === "instruction_loaded") {
      const approved = records.find(row => row.fact.id === raw.approvalRef);
      if (approved?.observation.kind !== "native_approved" || approved.observation.instructionHash !== raw.instructionHash
        || approved.observation.name !== raw.name || Date.parse(approved.observation.at) >= Date.parse(raw.at)
        || BINDING_KEYS.some(key => approved.observation[key] !== raw[key])) {
        return { status: "invalid", reason: "hermes_lifecycle_load_binding" };
      }
    }

    records.push({ fact, observation: raw });
  }

  return { status: "ready", records };
}
