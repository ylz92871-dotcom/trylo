import { fields, identity, text } from "../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeWork } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralRuntimeWork } from "../../learning/central/runtime/validation.js";
import type { CentralFundedStage } from "./contracts.js";
import { isCentralFundedStage } from "./funded-stage.js";
import { allocationFits } from "../../learning/control/allocation-shape.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { runtimeStageIsFree } from "./runtime-agent-execution-envelope.js";
import { readFrozenStage } from "./stage-evidence.js";

const stageAddress = ({ sourceContext: _sourceContext, ...address }: CentralFundedStage) => address;

/** The archive remains the stage owner. This frame only addresses that archive
 * and binds it to one public runtime operation; it is never a dispatch permit. */
export function runtimeAgentWork(options: { readonly intentId: string; readonly operation: CentralRuntimeWork["operation"];
  readonly scope: string; readonly budgetId: string; readonly authorizationRef: string;
  readonly input: CentralFundedStage; readonly digest: string }): CentralRuntimeWork {
  const frame = { schemaVersion: 2, type: "central_runtime_agent_stage", scope: options.scope,
    budgetId: options.budgetId, authorizationRef: options.authorizationRef, intentId: options.intentId,
    operationHash: contentHashOf(options.operation), inputJson: canonicalJson(stageAddress(options.input)),
    inputHash: contentHashOf(options.input), stageDigest: options.digest };
  return { intentId: options.intentId, operation: options.operation,
    workRef: `central-runtime-work:${contentHashOf(frame)}`, frame };
}

export function readRuntimeAgentWork(work: CentralRuntimeWork, scope: string) {
  const frame = work.frame;
  const common = ["schemaVersion", "type", "scope", "budgetId", "authorizationRef", "intentId", "operationHash", "inputJson", "stageDigest"];

  // V1 carries the original body. V2 addresses the same immutable frozen stage;
  // it never copies that large body into every runtime checkpoint.
  if (!isCentralRuntimeWork(work) || !(fields(frame, common) && frame.schemaVersion === 1
      || fields(frame, [...common, "inputHash"]) && frame.schemaVersion === 2 && identity(frame.inputHash))
    || frame.type !== "central_runtime_agent_stage" || frame.scope !== scope
    || !identity(frame.scope) || !identity(frame.budgetId) || !identity(frame.authorizationRef)
    || !identity(frame.intentId) || !identity(frame.operationHash) || !identity(frame.stageDigest)
    || frame.intentId !== work.intentId || frame.operationHash !== contentHashOf(work.operation)
    || work.operation.kind !== "dispatch" || !isCentralLearningAllowance(work.operation.allowance) || !text(frame.inputJson, CENTRAL_RUNTIME_LIMITS.jsonChars)
    || work.workRef !== `central-runtime-work:${contentHashOf(frame)}`) throw new Error("central_runtime_agent_frame_invalid");

  let input: unknown;

  try { input = JSON.parse(frame.inputJson); }
  catch { throw new Error("central_runtime_agent_frame_json"); }

  if (!isCentralFundedStage(input) || input.offer.owner.plane !== "agent" || canonicalJson(input) !== frame.inputJson
    || frame.schemaVersion === 2 && input.sourceContext !== undefined) {
    throw new Error("central_runtime_agent_frame_stage_invalid");
  }

  const cap = work.operation.allowance;
  if (!runtimeStageIsFree(input.offer) && (!allocationFits(input.offer.reserve, { tokens: cap.maxTokens, calls: cap.maxCalls, steps: cap.maxSteps })
    || input.offer.maxPromptChars > cap.maxPromptChars)) throw new Error("central_runtime_agent_frame_cap_mismatch");

  return { input, inputHash: frame.schemaVersion === 2 ? frame.inputHash as string : contentHashOf(input),
    budgetId: frame.budgetId, authorizationRef: frame.authorizationRef, stageDigest: frame.stageDigest,
    addressed: frame.schemaVersion === 2 };
}

/** Resolve full original content before execution or production attribution.
 * Both legacy and addressed frames require the same verified native archive. */
export async function readRuntimeAgentOriginalWork(work: CentralRuntimeWork, scope: string, boardRoot: string) {
  const decoded = readRuntimeAgentWork(work, scope);
  const frozen = await readFrozenStage({ boardRoot, scope, grantId: decoded.input.grantId, stageRef: decoded.input.stageRef });
  if (frozen.status !== "ready" || frozen.value.digest !== decoded.stageDigest || frozen.value.budgetId !== decoded.budgetId
    || contentHashOf(frozen.value.input) !== decoded.inputHash
    || canonicalJson(decoded.addressed ? stageAddress(frozen.value.input) : frozen.value.input) !== canonicalJson(decoded.input)) {
    throw new Error("central_runtime_agent_frozen_stage_unavailable");
  }

  return { ...decoded, input: frozen.value.input, frozen: frozen.value };
}
