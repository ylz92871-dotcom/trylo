import type { CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import type { CentralOpportunityConsideration, CentralRuntimeRead } from "../../learning/central/runtime/records.js";
import type { ProviderRecoveryUpdate } from "../../learning/central/runtime/provider-positive.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import { isCentralLearningRuntimeState } from "../../learning/central/runtime/validation.js";
import type { createCentralRuntimeStore } from "./runtime-store.js";
import { setTimeout } from "node:timers/promises";
import { readRewardV2BoardReason, readRewardV2BoardWriteOutcome } from "../reward/v2-board-port.js";

/** This attempt did not append. The current verified history may already
 * contain an identical command; callers must inspect it before proceeding. */
export class CentralRuntimeHeadChangedError extends Error {
  constructor(readonly expectedRef: string, readonly current: CentralRuntimeRead) {
    super("central_runtime_head_changed");
    this.name = "CentralRuntimeHeadChangedError";
  }
}

export class CentralRuntimeCheckpointBusyError extends Error {
  constructor(readonly reason: "multi_writer" | "stale_revision") {
    super(reason === "multi_writer" ? "central_runtime_writer_busy" : "central_runtime_write_stale");
    this.name = "CentralRuntimeCheckpointBusyError";
  }
}

const writerNotEntered = (error: unknown) => readRewardV2BoardReason(error) === "multi_writer"
  && readRewardV2BoardWriteOutcome(error) === "not_started";
export const isCentralRuntimeCheckpointContention = (error: unknown): boolean => error instanceof CentralRuntimeHeadChangedError
  || error instanceof CentralRuntimeCheckpointBusyError || writerNotEntered(error);

/** Saves one checkpoint through the original store; never reruns its producer. */
export async function saveCentralRuntimeCheckpoint(store: Pick<ReturnType<typeof createCentralRuntimeStore>, "read" | "append">,
  cursor: CentralRuntimeRead, state: CentralLearningRuntimeState, reason: string, sourceRefs: readonly string[],
  opportunityConsideration?: CentralOpportunityConsideration, providerRecoveryUpdate?: ProviderRecoveryUpdate): Promise<CentralRuntimeRead> {
  state = compactCentralWorkingSet(cursor.state, state, cursor.history.consumedSourceRefs,
    cursor.history.materials.map(row => row.ref));

  if (!isCentralLearningRuntimeState(state)) throw new Error("central_runtime_state_capacity_or_shape");

  const record = { previousRef: cursor.stateRef, state, reason, sourceRefs,
    ...(opportunityConsideration === undefined ? {} : { opportunityConsideration }),
    ...(providerRecoveryUpdate === undefined ? {} : { providerRecoveryUpdate }) };
  // Unrelated PA writes may advance the physical prefix after a read. Only a
  // definite stale result permits resubmitting this same checkpoint and command
  // identity. Any new semantic head, including our own idempotent write, stops.
  let busy: "multi_writer" | "stale_revision" = "stale_revision";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await store.read(state.scope);
    if (current.stateRef !== record.previousRef) throw new CentralRuntimeHeadChangedError(record.previousRef, current);

    let result;

    try { result = await store.append({ ...record, expectedRevision: current.revision }); }
    catch (error) {
      if (!writerNotEntered(error)) throw error;
      busy = "multi_writer";
      if (attempt < 3) await setTimeout(100 * (attempt + 1));
      continue;
    }

    switch (result.status) {
      case "written": return store.read(state.scope);
      case "stale": busy = "stale_revision";break;
      default: {
        const unexpected: never = result;
        throw unexpected;
      }
    }
  }

  throw new CentralRuntimeCheckpointBusyError(busy);
}
