import { canonicalJson } from "../../learning/control/hash.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { CentralFundedStage } from "./contracts.js";
import { isCentralFundedStage } from "./funded-stage.js";
import { readFrozenStage } from "./stage-evidence.js";
import { readCentralStageContext } from "./source-context.js";

/** A prepared public packet, including its original fallback, belongs to that
 * immutable stage. Ordinary later knowledge only affects the next preparation. */
export async function readPreparedCentralStageContext(options: {
  readonly boardRoot: string;
  readonly scope: string;
  readonly input: CentralFundedStage;
  readonly reader?: CentralLearningContextReader;
}): ReturnType<typeof readCentralStageContext> {
  if (!isCentralFundedStage(options.input)) return { status: "rejected", reason: "central_stage_context_input_invalid" };

  const frozen = await readFrozenStage({ boardRoot: options.boardRoot, scope: options.scope,
    grantId: options.input.grantId, stageRef: options.input.stageRef });
  if (frozen.status !== "ready") return frozen.reason === "central_stage_archive_missing" && options.input.sourceContext === undefined
    ? readCentralStageContext(options.reader, options.input.issueId) : { status: "rejected", reason: frozen.reason };

  if (canonicalJson(frozen.value.input) !== canonicalJson(options.input)) return { status: "rejected", reason: "central_stage_context_frozen_input_mismatch" };

  if (options.input.sourceContext === undefined) return readCentralStageContext(options.reader, options.input.issueId);

  return { status: "ready", context: { ...options.input.sourceContext } };
}
