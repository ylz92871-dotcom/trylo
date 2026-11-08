import type { CentralRuntimeDriver } from "../../adapters/central-learning-runtime/contracts.js";
import type { CentralLearningDriverProgress } from "../../learning/central/runtime/contracts.js";

/** Complete source membership remains in the original domain history. The
 * process host carries only a bounded scheduling/diagnostic signal. */
export function centralRuntimeResultSignal(result: CentralLearningDriverProgress): Awaited<ReturnType<CentralRuntimeDriver["drive"]>> {
  return { state: result.state, reason: result.reason, sourceRefs: result.sourceRefs.slice(0, 32),
    ...(result.wakeAt === undefined ? {} : { wakeAt: result.wakeAt }) };
}
