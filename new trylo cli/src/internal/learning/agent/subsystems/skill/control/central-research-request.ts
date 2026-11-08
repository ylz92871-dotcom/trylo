import type { CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeMaterial } from "../../../../central/runtime/contracts.js";
import { isCentralLearningIntent, isCentralLearningOperation, isCentralRuntimeMaterial, isCentralRuntimeReferences } from "../../../../central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { fields, identity } from "../../../../../validation/json-shape.js";
import type { HermesSkillOpportunity } from "../contracts.js";

/** A native research request is a public learning purpose, never a completed task
 * or an asset. The original skill review still owns its pending proposals. */
export interface CentralSkillResearchRequest {
  readonly schemaVersion: 1;
  readonly type: "skill_research_request";
  readonly scope: string;
  readonly workspaceRoot: string;
  readonly requestRef: string;
  readonly intentRef: string;
  readonly intent: CentralLearningIntentDraft;
  readonly operation: Extract<CentralLearningOperation, { kind: "dispatch" }>;
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly sourceRefs: readonly string[];
}

export const CENTRAL_SKILL_RESEARCH_ALGORITHM = "central-skill-research-v1";
const INTERPRETATION = "Public source-qualified research request. This is not a task transcript, a new independent observation, a success verdict, a skill approval or tool permission. Keep the stated conditions and unresolved questions; use only the mounted native skill tools.";

export function centralSkillResearchIssueId(request: Pick<CentralSkillResearchRequest, "scope" | "requestRef">): string {
  return `skill-research-issue:${contentHashOf([request.scope, request.requestRef])}`;
}

export function centralSkillResearchRecordId(request: CentralSkillResearchRequest): string {
  return `skill-research-source:${contentHashOf(request)}`;
}

export function isCentralSkillResearchRequest(value: unknown): value is CentralSkillResearchRequest {
  return fields(value, ["schemaVersion", "type", "scope", "workspaceRoot", "requestRef", "intentRef", "intent", "operation", "materials", "sourceRefs"])
    && value.schemaVersion === 1 && value.type === "skill_research_request"
    && [value.scope, value.workspaceRoot, value.requestRef, value.intentRef].every(identity)
    && isCentralLearningIntent(value.intent) && value.intent.intentId === value.intentRef
    && value.intent.subject.plane === "central" && value.intent.subject.questionRef === value.intentRef
    && isCentralLearningOperation(value.operation) && value.operation.kind === "dispatch"
    && value.intent.continuation.kind === "ready" && canonicalJson(value.intent.continuation.operation) === canonicalJson(value.operation)
    && (value.operation.destination === undefined || value.operation.destination.plane === "agent" && value.operation.destination.domain === "skill")
    && Array.isArray(value.materials) && value.materials.length > 0 && value.materials.length <= 256
    && value.materials.every(isCentralRuntimeMaterial) && new Set(value.materials.map(item => item.ref)).size === value.materials.length
    && isCentralRuntimeReferences(value.sourceRefs) && value.sourceRefs.length > 0;
}

/** Native Hermes has no requirement for session/turn locators on explicit work.
 * Preserve the complete public purpose and materials instead of inventing one. */
export function centralSkillResearchOpportunity(request: CentralSkillResearchRequest): HermesSkillOpportunity {
  return { trigger: "explicit", workspaceRoot: request.workspaceRoot, taskGoal: request.intent.goal,
    learnRequest: request.operation.purpose,
    experience: { schemaVersion: 1, kind: "research_request", requestRef: request.requestRef,
      intentRef: request.intentRef, interpretation: INTERPRETATION,
      // JSON text retains the canonical typed payload without teaching this
      // adapter a second conversion of every central public-context field.
      publicResearchRequest: canonicalJson(request) } };
}

export function centralSkillResearchFitsNative(request: CentralSkillResearchRequest): boolean {
  // The native capsule's actual transport fence is 64,000 characters. Leave
  // room for the managed source's current public-context sidecar.
  return JSON.stringify(centralSkillResearchOpportunity(request).experience).length <= 60_000;
}
