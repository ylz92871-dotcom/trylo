import { err, ok, type Result } from "../../../../../tooling/contract/result.js";
import type {
  GapKind,
  ToolLearningObservation,
  ObservationKind,
  ToolGapDraft,
} from "../../../../../tooling/contract/types.js";
import type { GapDetection } from "../../../../../tooling/contract/types.js";

export type GapPolicy = {
  readonly repeatThreshold: number;
  readonly highCriticalityThreshold: number;
};

export const DEFAULT_GAP_POLICY: GapPolicy = {
  repeatThreshold: 3,
  highCriticalityThreshold: 2,
};

const FAILURE_KINDS: ReadonlySet<ObservationKind> = new Set([
  "tool_not_found",
  "tool_failure",
  "schema_friction",
  "platform_incompatible",
  "manual_workaround",
  "capability_mismatch",
]);

function observationToGapKind(kind: ObservationKind): GapKind | undefined {
  switch (kind) {
    case "tool_not_found":
      return "tool_not_found";
    case "tool_failure":
      return "repeated_tool_failure";
    case "schema_friction":
      return "poor_schema_or_description";
    case "platform_incompatible":
      return "platform_incompatible";
    case "manual_workaround":
      return "excessive_manual_workaround";
    case "capability_mismatch":
      return "capability_mismatch";
    case "success":
      return undefined;
  }
}

function groupKey(observation: ToolLearningObservation): string {
  return `${observation.taskFamily}::${observation.capability}`;
}

export function detectToolGap(
  observations: readonly ToolLearningObservation[],
  policy: GapPolicy = DEFAULT_GAP_POLICY,
): Result<GapDetection, "invalid_observation"> {
  if (observations.length === 0) {
    return err("invalid_observation", "ToolGap requires at least one observation");
  }

  for (const observation of observations) {
    if (observation.observationId.length === 0 || observation.capability.length === 0) {
      return err("invalid_observation", "observationId and capability are required");
    }
  }

  const first = observations[0];
  if (first === undefined) {
    return err("invalid_observation", "ToolGap requires at least one observation");
  }

  const key = groupKey(first);

  for (const observation of observations) {
    if (groupKey(observation) !== key) {
      return err("invalid_observation", "mixed capability/taskFamily groups are not a single gap");
    }
  }

  const successes = observations.filter((item) => item.kind === "success");
  const failures = observations.filter((item) => FAILURE_KINDS.has(item.kind));
  const ids = observations.map((item) => item.observationId);

  if (successes.length > 0 && failures.length < policy.repeatThreshold) {
    return ok({
      decision: "no_change",
      reason: "existing_tool_good_enough",
      observationIds: ids,
      explanation: "existing tool already succeeds on this capability",
    });
  }

  if (failures.length === 0) {
    return ok({
      decision: "no_change",
      reason: "existing_tool_good_enough",
      observationIds: ids,
      explanation: "no failure evidence",
    });
  }

  const highNoFallback = failures.some(
    (item) => item.criticality === "high" && item.fallbackAvailable === false,
  );
  const threshold = highNoFallback ? policy.highCriticalityThreshold : policy.repeatThreshold;
  if (failures.length < threshold) {
    return ok({
      decision: "no_change",
      reason: "below_repeat_threshold",
      observationIds: ids,
      explanation: `repeat count ${failures.length} below threshold ${threshold}`,
    });
  }

  const dominant = failures[failures.length - 1];
  if (dominant === undefined) {
    return err("invalid_observation", "failure set empty after threshold check");
  }

  const kind = observationToGapKind(dominant.kind);
  if (kind === undefined) {
    return err("invalid_observation", "cannot derive gap kind");
  }

  const gap: ToolGapDraft = {
    gapId: `gap:${key}:${failures.length}`,
    kind,
    observationIds: failures.map((item) => item.observationId),
    capability: dominant.capability,
    taskFamily: dominant.taskFamily,
    criticality: dominant.criticality,
    repeatCount: failures.length,
    fallbackAvailable: dominant.fallbackAvailable,
    explanation: `repeated ${kind} with ${failures.length} observations`,
  };

  return ok({ decision: "gap", gap });
}
