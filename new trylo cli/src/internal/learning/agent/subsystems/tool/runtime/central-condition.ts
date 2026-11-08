import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";

/** A named existing capability has a reusable original input/usage contract.
 * An open-ended need, retrieved catalog or task-text hash cannot stand in for
 * that class before the original planner has identified one. */
export function toolCentralCondition(state: BoardState, plan: ToolLearningPlan) {
  if (plan.targetVersionId === undefined) return undefined;

  const selected = toolLearningParentFromBoard(state, plan.targetVersionId);
  if (!selected.ok) return undefined;

  const parent = selected.parent, descriptor = parent.kind === "generated" ? parent.artifact.candidate : parent.plan.candidate;
  const features: JsonObject = { kind: "target_tool_interface_contract", capabilityIdentity: descriptor.identity,
    inputSchema: descriptor.inputSchema, whenToUse: descriptor.mastery.whenToUse,
    preconditions: descriptor.mastery.preconditions, pitfalls: descriptor.mastery.pitfalls,
    runtimeClass: parent.kind === "npm" ? parent.plan.runtime.profile : parent.kind };

  return { ref: `tool-condition:${contentHashOf(features)}`, sourceRef: "trylo:tool-target-interface-condition:v1", features };
}
