import { submitDraftCommand, type BoardCommandDraft } from "../../../../domains/shared/board-command.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type {
  DraftStatus,
  PromptOp,
  PromptSection,
  Provenance,
  Scope,
} from "../../../../domains/shared/types.js";
import { DRAFT_STATUS } from "../../../../domains/shared/types.js";
import type { PromptAttributionRecord } from "./attribution.js";

export type PromptPatchDraft = {
  readonly kind: "prompt_patch";
  readonly status: DraftStatus;
  readonly id: string;
  readonly baselinePromptHash: string;
  readonly candidatePatch: readonly PromptOp[];
  readonly patchTarget: PromptSection | "mixed";
  readonly targetMetric: "external_verdict";
  readonly scope: Scope;
  readonly taskFamilyId: string;
  readonly intentClass: string;
  readonly versions: PromptAttributionRecord["versions"];
  readonly causalObservationRefs: readonly [string, string];
  readonly externalResult: PromptAttributionRecord["externalResult"];
  readonly expectedBenefit: string;
  readonly expectedOutcome: "external_verdict_improves";
  readonly regressionRisks: readonly string[];
  readonly invariants: readonly string[];
  readonly privacy: PromptAttributionRecord["privacy"];
  readonly provenance: Provenance;
  readonly threshold: number;
  readonly activationEligible: false;
  readonly command: BoardCommandDraft;
};

export function buildPromptPatchDraft(
  record: PromptAttributionRecord,
): PromptPatchDraft {
  const id = shortId("pp", [
    record.baselinePromptHash,
    record.causalObservationRefs[0],
    record.causalObservationRefs[1],
  ]);
  return {
    kind: "prompt_patch",
    status: DRAFT_STATUS,
    id,
    baselinePromptHash: record.baselinePromptHash,
    candidatePatch: record.candidatePatch,
    patchTarget: patchTargetOf(record.candidatePatch),
    targetMetric: "external_verdict",
    scope: { kind: "task_family", id: record.taskFamily.id },
    taskFamilyId: record.taskFamily.id,
    intentClass: record.taskFamily.intentClass,
    versions: record.versions,
    causalObservationRefs: record.causalObservationRefs,
    externalResult: record.externalResult,
    expectedBenefit: record.expectedBenefit,
    expectedOutcome: "external_verdict_improves",
    regressionRisks: record.regressionRisks,
    invariants: [
      "no permission fields",
      "no tool install or switch",
      "no workflow topology change",
      "draft is not active",
    ],
    privacy: record.privacy,
    provenance: {
      source: "inferred_from_observations",
      observationRefs: record.causalObservationRefs,
      createdBy: "prompt_detector",
    },
    threshold: record.threshold,
    activationEligible: false,
    command: submitDraftCommand("prompt_patch", id),
  };
}

function patchTargetOf(ops: readonly PromptOp[]): PromptSection | "mixed" {
  const sections = new Set<PromptSection>();

  for (const op of ops) {
    if (op.op === "replace_section") {
      sections.add(op.section);
    }
  }

  if (sections.size === 1) {
    return [...sections][0] ?? "mixed";
  }

  return "mixed";
}
