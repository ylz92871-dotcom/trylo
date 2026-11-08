import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { toolLearningProductionFailures, toolProductionFailureFeedback } from "./production-check-reader.js";

/** Independent check failures add safe diagnostic context, never new expected answers. */
export async function npmAdaptationFeedback(input: NpmAdaptationInput) {
  if (input.plan.targetVersionId === undefined) return { ok: true as const, input };

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const facts = toolLearningProductionFailures(loaded.state, input.plan);
  if (!facts.ok) return facts;

  const extra = toolProductionFailureFeedback(facts.failures);
  if (extra.length === 0) return { ok: true as const, input };

  const feedback = (prior: string) => `${prior.slice(0, 6_000)}\n${extra}`;

  return { ok: true as const, input: { ...input,
    ...(input.parent === undefined ? {} : { parent: { ...input.parent, feedback: feedback(input.parent.feedback) } }),
    ...(input.predecessor === undefined ? {} : { predecessor: { ...input.predecessor, feedback: feedback(input.predecessor.feedback) } }) } };
}
