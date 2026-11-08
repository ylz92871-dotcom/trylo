import { createMethodCentralLearning } from "../../learning/agent/subsystems/method/adapters/index.js";
import type { CentralLearningExecutionPort } from "./contracts.js";

/** Thin host composition; method qualification, review and adoption remain in the domain. */
export function createCentralMethodExecutor(options: Parameters<typeof createMethodCentralLearning>[0]): CentralLearningExecutionPort {
  const owner = createMethodCentralLearning(options);
  return { domain: "prompt", nominate: owner.nominate, prepare: owner.prepare, dispatch: owner.dispatch, observe: owner.observe };
}
