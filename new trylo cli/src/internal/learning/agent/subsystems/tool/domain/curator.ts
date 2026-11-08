import type { DiscoveryPort } from "../assets/acquisition/discovery.js";
import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../../../../../tooling/approval/gates.js";
import { err, ok, type Result } from "../../../../../tooling/contract/result.js";
import type {
  ToolBoardCommandDraft,
  ToolLearningObservation,
  ToolBindingDraft,
  ToolCandidate,
  ToolGapDraft,
  ValidationRecord,
} from "../../../../../tooling/contract/types.js";
import type { BoardCommandPort } from "./board-adapter.js";
import { runLearningPipeline } from "./pipeline.js";
import type { CuratorJob } from "./retry-breaker.js";

export type CuratorPermissions = {
  readonly network: false;
  readonly shell: false;
  readonly executionLoop: false;
};

export const CURATOR_PERMISSIONS: CuratorPermissions = {
  network: false,
  shell: false,
  executionLoop: false,
};

export type CuratorRun = {
  readonly job: CuratorJob;
  readonly submitted: readonly ToolBoardCommandDraft[];
};

export function runToolCurator(input: {
  readonly job: CuratorJob;
  readonly observations: readonly ToolLearningObservation[];
  readonly discovery: DiscoveryPort;
  readonly board: BoardCommandPort;
}): Result<CuratorRun, "job_stopped" | "invalid_observation"> {
  const result = runLearningPipeline(input);
  if (!result.ok) {
    if (result.code === "invalid_observation") {
      return err("invalid_observation", result.message);
    }
    return err("job_stopped", result.message);
  }

  return ok({
    job: result.value.job,
    submitted: result.value.commands,
  });
}

export async function submitBindingDraft(
  board: BoardCommandPort,
  draft: ToolBindingDraft,
  validation: ValidationRecord | undefined,
  activation: {
    /** Grant reference issued by the Permission Service; facts are verified by the store. */
    readonly token?: ApprovalGrantRef;
    readonly now: string;
    /** Injected one-time authorization consumer. Absent means no activation. */
    readonly approvalPort?: ApprovalConsumptionPort;
  },
): Promise<Result<ToolBindingDraft, "unverified_not_bindable" | ApprovalGateFailure>> {
  if (validation === undefined || validation.verdict !== "pass" || validation.actor !== "verifier") {
    return err("unverified_not_bindable", "binding drafts require an independent verifier pass");
  }

  if (validation.packageVersionId !== draft.packageVersionId) {
    return err("unverified_not_bindable", "validation does not cover this package version");
  }

  const gate = await consumeApproval(activation.approvalPort, {
    action: "activate",
    candidateId: draft.candidateId,
    packageVersionId: draft.packageVersionId,
    scope: draft.scope,
    now: activation.now,
    ...(activation.token === undefined ? {} : { token: activation.token }),
  });
  if (!gate.ok) {
    return gate;
  }

  board.submit({ kind: "submit_binding_draft", draft });

  return ok(draft);
}

export function curatorOwnsExecutionLoop(): false {
  return false;
}

export function curatorMayApproveOwnTool(): false {
  return false;
}

export function listedCandidateIds(
  submitted: readonly ToolBoardCommandDraft[],
): readonly string[] {
  return submitted
    .filter(
      (command): command is Extract<ToolBoardCommandDraft, { kind: "submit_candidate" }> =>
        command.kind === "submit_candidate",
    )
    .map((command) => command.candidate.candidateId);
}

export type { ToolCandidate, ToolGapDraft };
