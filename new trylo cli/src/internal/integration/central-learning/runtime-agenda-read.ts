import type { CentralAgendaRead, CentralLearningOperation, CentralLearningRuntimeState,
  CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { centralAgendaReadReviewId, unreviewedCentralAgendaReads } from "../../learning/central/runtime/working-set.js";
import { completeOperation, mergeRuntimeMaterials, operationCompleted } from "../../learning/central/runtime/transitions.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { readOperationRefusal } from "./runtime-read-operation.js";

/** The pending read is already authorized by an original delivered decision.
 * A returned read opens one review of its actual target/result version, not
 * another learning intent or a fresh observation on each notification. */
export function nextCentralAgendaOperation(state: CentralLearningRuntimeState,
  history?: CentralRuntimeHistory): CentralLearningOperation | undefined {
  if (state.agendaRead !== undefined) return state.agendaRead;

  for (const read of unreviewedCentralAgendaReads(state)) {
    const operation: CentralLearningOperation = {
      kind: "think", operationId: centralAgendaReadReviewId(state.scope, read),
      purpose: "根据刚实际读取的原件审议学习问题；正文尚未支持目的时，不把导航或读取回执当作学习证据。",
      expectedChange: read.operation.expectedChange,
      sourceRefs: [...new Set([read.operation.operationId, ...("refs" in read.operation ? read.operation.refs : []), ...read.resultRefs])],
    };
    if (!operationCompleted(state, operation, history)) return operation;
  }

  return undefined;
}

export function isPendingCentralAgendaRead(state: CentralLearningRuntimeState, operation: CentralLearningOperation): boolean {
  return state.agendaRead !== undefined && canonicalJson(state.agendaRead) === canonicalJson(operation);
}

/** Returns state to the original checkpoint writer. A read refusal is a local
 * original receipt, never new grounds for another paid agenda computation. */
export async function performCentralAgendaRead(input: {
  readonly state: CentralLearningRuntimeState; readonly history: CentralRuntimeHistory;
  readonly operation: CentralAgendaRead; readonly source: CentralRuntimeSourcePort;
  readonly signal: AbortSignal; readonly enabled: () => boolean;
}): Promise<{ readonly state: CentralLearningRuntimeState; readonly reason: string; readonly sourceRefs: readonly string[] }> {
  if (!isPendingCentralAgendaRead(input.state, input.operation)) throw new Error("central_agenda_read_identity_mismatch");

  if (input.signal.aborted || !input.enabled()) throw new Error("central_runtime_disabled_or_cancelled");

  const request = { scope: input.state.scope, operation: input.operation, materials: input.state.materials, history: input.history };
  let refused = readOperationRefusal(request), materials: readonly CentralRuntimeMaterial[] = [];
  if (refused === undefined) {
    try { materials = await input.source.read(input.state.scope, input.operation.refs, input.operation.maximumChars, input.signal); }
    catch (error) {
      if (input.signal.aborted || !input.enabled()) throw error;
      refused = readOperationRefusal({ ...request, error });
      // Unknown IO, privacy, ownership and cancellation failures retain the
      // same pending operation; they are not fabricated negative observations.
      if (refused === undefined) throw error;
    }
  }

  const resultRefs = materials.map(material => material.ref);
  const result = refused?.result ?? { outcome: "returned" as const,
    publicResult: `已完成议程原件读取，公开正文保留原引用：${resultRefs.join(", ")}。`, resultRefs };
  const { agendaRead: _pending, ...withoutPending } = input.state;
  const completed = completeOperation(withoutPending, { intentId: "central:agenda", operation: input.operation, result });

  return { state: { ...completed, materials: mergeRuntimeMaterials(completed.materials, materials) },
    reason: refused === undefined ? "central_agenda_source_read_returned" : "central_agenda_source_read_refused",
    sourceRefs: [...new Set([input.operation.operationId, ...result.resultRefs, ...(result.wait?.sourceRefs ?? [])])] };
}
