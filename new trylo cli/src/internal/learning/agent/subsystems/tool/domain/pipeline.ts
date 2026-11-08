import { assessCandidates } from "../assets/acquisition/comparator.js";
import type { DiscoveryPort } from "../assets/acquisition/discovery.js";
import { normalizeHits } from "../assets/acquisition/discovery.js";
import { err, ok, type Result } from "../../../../../tooling/contract/result.js";
import type {
  ToolBoardCommandDraft,
  ToolLearningObservation,
  ToolCandidate,
  ToolGapDraft,
  ToolingEvent,
} from "../../../../../tooling/contract/types.js";
import { createMemoryLog } from "../assets/events/memory-log.js";
import { createSideEffectGuard, type SideEffectGuard } from "../../../../../tooling/side-effects.js";
import type { BoardCommandPort } from "./board-adapter.js";
import { detectToolGap } from "./gap-detector.js";
import { mayRetry, recordJobOutcome, type CuratorJob } from "./retry-breaker.js";

export type LearningPipelineResult = {
  readonly job: CuratorJob;
  readonly commands: readonly ToolBoardCommandDraft[];
  readonly events: readonly ToolingEvent[];
  readonly gap?: ToolGapDraft;
  readonly candidates: readonly ToolCandidate[];
  readonly sideEffects: readonly string[];
};

export function runLearningPipeline(input: {
  readonly job: CuratorJob;
  readonly observations: readonly ToolLearningObservation[];
  readonly discovery: DiscoveryPort;
  readonly board: BoardCommandPort;
  readonly guard?: SideEffectGuard;
}): Result<LearningPipelineResult, "job_stopped" | "invalid_observation" | "side_effect_forbidden"> {
  const guard = input.guard ?? createSideEffectGuard();

  if (!mayRetry(input.job)) {
    return err("job_stopped", "curator will not retry a terminal job");
  }

  const gap = detectToolGap(input.observations);
  if (!gap.ok) {
    return gap;
  }

  const log = createMemoryLog();

  if (gap.value.decision === "no_change") {
    return ok({
      job: recordJobOutcome(input.job, "success"),
      commands: input.board.snapshot(),
      events: log.events(),
      candidates: [],
      sideEffects: guard.attempts(),
    });
  }

  input.board.submit({ kind: "submit_gap", gap: gap.value.gap });
  const found = input.discovery.search(gap.value.gap.capability);
  if (!found.ok) {
    return ok({
      job: recordJobOutcome(input.job, "failed"),
      commands: input.board.snapshot(),
      events: log.events(),
      gap: gap.value.gap,
      candidates: [],
      sideEffects: guard.attempts(),
    });
  }

  const candidates = normalizeHits(found.value);
  const assessed = assessCandidates(candidates);
  if (!assessed.ok || assessed.value.kind === "no_suitable_candidate") {
    input.board.submit({
      kind: "submit_evidence",
      evidenceId: `${gap.value.gap.gapId}:none`,
      summary: "no suitable candidate; modify/create still requires a separate approval",
    });
    return ok({
      job: recordJobOutcome(input.job, "success"),
      commands: input.board.snapshot(),
      events: log.events(),
      gap: gap.value.gap,
      candidates,
      sideEffects: guard.attempts(),
    });
  }

  for (const scored of assessed.value.suitable) {
    input.board.submit({ kind: "submit_candidate", candidate: scored.candidate });
  }

  return ok({
    job: { ...input.job, state: "waiting_approval" },
    commands: input.board.snapshot(),
    events: log.events(),
    gap: gap.value.gap,
    candidates: assessed.value.suitable.map((item) => item.candidate),
    sideEffects: guard.attempts(),
  });
}
