import { canonicalJson } from "../../../../control/hash.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ExperienceBoundaryReceipt, ExperienceUseFeedback } from "../../../../../protocol/collaboration-experience.js";
import type { CollaborationRuntimeReceipt } from "../../../../../protocol/collaboration-resource.js";
import { isCollaborationRuntimeReceipt } from "../../../../control/collaboration-runtime-parse.js";
import { publishCollaborationArtifact } from "../artifacts/publish.js";
import type { CollaborationExperienceContent, ExperienceResult, PreparedExperience, PrepareExperienceInput, PublishExperienceInput } from "./contracts.js";
import { isPrepareExperienceInput, isPublishExperienceInput } from "./parse.js";
import { experienceOwnerFingerprint, selectExperience } from "./policy.js";
import { collaborationExperiencePublicationValid } from "./provenance.js";
import { isExperienceQueryOptions, queryExperience, type ExperienceQueryOptions, type ExperienceQueryResult } from "./query.js";

export type ExperienceStoreOptions = {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly scope: string;
  readonly now: () => string;
  readonly enabled?: () => boolean;
  readonly canPublish?: () => Promise<boolean>;
  readonly recordRuntimeReceipt?: (receipt: CollaborationRuntimeReceipt) => Promise<ExperienceResult<Record<never, never>>>;
};

export type ExperienceReceiptInput = Omit<ExperienceBoundaryReceipt, "schemaVersion" | "phase" | "scope" | "ownerFingerprint">;

export type ExperienceFeedbackInput = Omit<ExperienceUseFeedback, "schemaVersion" | "phase" | "scope">;

export type CollaborationExperienceStore = ReturnType<typeof createCollaborationExperienceStore>;

/** Content ownership lives here; the shared publisher and Board retain lifecycle/write authority. */
export function createCollaborationExperienceStore(options: ExperienceStoreOptions) {
  const enabled = () => options.enabled?.() !== false;

  async function validatePublication(input: PublishExperienceInput): Promise<ExperienceResult<{
    input: PublishExperienceInput; content: CollaborationExperienceContent;
  }>> {
    if (!enabled()) return { ok: false, reason: "collect_disabled" };

    let owned: unknown;

    try { owned = JSON.parse(canonicalJson(input)); }
    catch { return { ok: false, reason: "experience_input_invalid" }; }

    if (!isPublishExperienceInput(owned)) return { ok: false, reason: "experience_input_invalid" };

    try {
      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      if (!enabled()) return { ok: false, reason: "collect_disabled" };

      const issue = loaded.state.learningIssues?.find(i => i.issueId === owned.issueId && i.scope === options.scope);
      if (issue?.decision.kind !== "focused_learning") return { ok: false, reason: "issue_no_longer_focused" };

      const content = contentFor(owned, issue.decision.revision);
      if (!collaborationExperiencePublicationValid(loaded.state, options.scope, content)) return { ok: false, reason: "experience_sources_invalid" };

      return { ok: true, input: owned, content };
    } catch { return { ok: false, reason: "board_unavailable" }; }
  }

  /** Read-only admission for a whole candidate batch; it does not promise an IO transaction or reserve publication. */
  async function preflightExperience(input: PublishExperienceInput): Promise<ExperienceResult<{ input: PublishExperienceInput }>> {
    const checked = await validatePublication(input);
    return checked.ok ? { ok: true, input: checked.input } : checked;
  }

  async function publishExperience(input: PublishExperienceInput): Promise<ExperienceResult<{ versionId: string; proposalId: string }>> {
    const checked = await validatePublication(input);
    if (!checked.ok) return checked;
    const content = checked.content;
    try { return await publishCollaborationArtifact(options, { issueId: content.issueId, familyId: content.familyId,
        title: content.situation, hypothesis: content.practice, sourceRefs: content.sourceRefs, content, schemaVersion: 1,
        ...(content.parentVersionId === undefined ? {} : { parentVersionId: content.parentVersionId }), kind: "experience" });
    } catch { return { ok: false, reason: "board_unavailable" }; }
  }

  async function prepareExperience(input: PrepareExperienceInput): Promise<ExperienceResult<PreparedExperience>> {
    if (!enabled()) return { ok: false, reason: "collect_disabled" };
    try {
      const owned: unknown = JSON.parse(canonicalJson(input));
      if (!isPrepareExperienceInput(owned)) return { ok: false, reason: "experience_context_invalid" };
      if (owned.owner.kind === "legacy_member" && owned.owner.workspace !== options.scope) return { ok: false, reason: "experience_scope_mismatch" };
      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };
      if (!enabled()) return { ok: false, reason: "collect_disabled" };
      return { ok: true, ...selectExperience(loaded.state, options.scope, owned) };
    } catch { return { ok: false, reason: "board_unavailable" }; }
  }

  async function receipt(phase: ExperienceBoundaryReceipt["phase"], input: ExperienceReceiptInput): Promise<ExperienceResult<Record<never, never>>> {
    if (!enabled()) return { ok: false, reason: "collect_disabled" };

    if (options.recordRuntimeReceipt === undefined) return { ok: false, reason: "runtime_receipt_unavailable" };

    try {
      const owned: unknown = JSON.parse(canonicalJson({ ...input, schemaVersion: 1, phase, scope: options.scope,
        ownerFingerprint: experienceOwnerFingerprint(input.owner) }));
      if (!isCollaborationRuntimeReceipt(owned) || owned.phase !== phase || (owned.phase !== "loaded" && owned.phase !== "dispatched")) {
        return { ok: false, reason: "runtime_receipt_invalid" };
      }
      return enabled() ? await options.recordRuntimeReceipt(owned) : { ok: false, reason: "collect_disabled" };
    } catch { return { ok: false, reason: "runtime_receipt_unavailable" }; }
  }

  async function inspectExperience(input: PrepareExperienceInput, query: ExperienceQueryOptions = {}): Promise<ExperienceResult<ExperienceQueryResult>> {
    if (!enabled()) return { ok: false, reason: "collect_disabled" };
    try {
      const owned: unknown = JSON.parse(canonicalJson(input));
      const ownedQuery: unknown = JSON.parse(canonicalJson(query));
      if (!isPrepareExperienceInput(owned) || !isExperienceQueryOptions(ownedQuery)) return { ok: false, reason: "experience_context_invalid" };

      if (owned.owner.kind === "legacy_member" && owned.owner.workspace !== options.scope) return { ok: false, reason: "experience_scope_mismatch" };

      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      if (!enabled()) return { ok: false, reason: "collect_disabled" };

      return { ok: true, ...queryExperience(loaded.state, options.scope, owned, ownedQuery) };
    } catch { return { ok: false, reason: "board_unavailable" }; }
  }

  async function recordUseFeedback(input: ExperienceFeedbackInput): Promise<ExperienceResult<Record<never, never>>> {
    if (!enabled()) return { ok: false, reason: "collect_disabled" };

    if (options.recordRuntimeReceipt === undefined) return { ok: false, reason: "runtime_receipt_unavailable" };

    try {
      const owned: unknown = JSON.parse(canonicalJson({ ...input, schemaVersion: 1, phase: "use_feedback", scope: options.scope }));
      if (!isCollaborationRuntimeReceipt(owned) || owned.phase !== "use_feedback") return { ok: false, reason: "runtime_receipt_invalid" };
      return enabled() ? await options.recordRuntimeReceipt(owned) : { ok: false, reason: "collect_disabled" };
    } catch { return { ok: false, reason: "runtime_receipt_unavailable" }; }
  }

  return { publishExperience, preflightExperience, prepareExperience, inspectExperience, recordLoad: (input: ExperienceReceiptInput) => receipt("loaded", input),
    recordDispatch: (input: ExperienceReceiptInput) => receipt("dispatched", input), recordUseFeedback };
}

function contentFor(input: PublishExperienceInput, focusRevision: number): CollaborationExperienceContent {
  return { schema: "collaboration-experience/v1", status: "trial", issueId: input.issueId, focusRevision,
    familyId: input.familyId, owner: input.owner, situation: input.situation, responsibilities: input.responsibilities,
    practice: input.practice, sourceRefs: [...new Set(input.sourceRefs)], conditions: input.conditions ?? {},
    ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
    ...(input.expertIdentity === undefined ? {} : { sourceExpert: input.expertIdentity }),
    ...(input.expertVersion === undefined ? {} : { expertVersion: input.expertVersion }),
    ...(input.parentVersion === undefined ? {} : { parentVersionId: input.parentVersion }) };
}
