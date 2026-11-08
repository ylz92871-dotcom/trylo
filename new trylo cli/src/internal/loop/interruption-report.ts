import type { ReduceInput } from "../domain/input.js";
import { ExecutionProgressError } from "../ports/execution-progress.js";
import type { Transcript } from "../protocol/transcript.js";
import type { JsonObject } from "../protocol/envelope.js";
import { REPORT_TOOLS } from "./budget-final-report.js";
import { budgetCeiling } from "./budget-gate.js";
import { cancellationStanding, type CancelWatch } from "./cancel.js";
import { checkpointGoal, stopInactiveGoal } from "./goal-boundary.js";
import { nextId } from "./journal-emit.js";
import { currentPhase, dispatch, unsettledToolCallCount } from "./runner-effects.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";
import type { InterruptionReport, IterationPurpose } from "./report-instructions.js";

export type { IterationPurpose } from "./report-instructions.js";
type ReportIteration = (engine: Engine, ports: LoopPorts, cancelled: CancelWatch, purpose: IterationPurpose) => Promise<unknown>;

/** Unknown effects cannot be retried by the caller's optional turn repair. */
export function hasUnknownToolResult(engine: Engine): boolean {
  return Object.values(engine.state.toolCalls).some(call => call.status === "unknown");
}

/** The report borrows the same provider and acknowledged progress writer.
 * It never acquires a lease, clears an effect, or reopens execution tools. */
export async function reportInterruption(engine: Engine, ports: LoopPorts, cancelled: CancelWatch,
  cause: InterruptionReport["cause"], run: ReportIteration): Promise<void> {
  if (!cancellationStanding(cancelled, engine)) await checkpointGoal(engine, ports);

  if (cancellationStanding(cancelled, engine)) {
    await dispatch(engine, ports, { type: "cancel", eventId: nextId(engine) });
    return;
  }
  if (await stopInactiveGoal(engine, ports) || await budgetCeiling(engine, ports)) return;

  const { method: _method, toolGap: _toolGap, ...ordinary } = ports;
  await run(engine, { ...ordinary, tools: REPORT_TOOLS }, cancelled, { kind: "interruption_report", cause });

  if (currentPhase(engine) !== "terminal") {
    await dispatch(engine, ports, { type: "turn_failed", eventId: nextId(engine), reason: cause });
  }
}

/** Only an acknowledged unknown settlement is reportable. Any outstanding
 * parallel member, missing provider finish, or other write failure escapes to
 * the host's closed-lease system explanation without another provider request. */
export async function reportUnknownSettlement(engine: Engine, ports: LoopPorts, cancelled: CancelWatch,
  error: unknown, inputs: readonly ReduceInput[], run: ReportIteration): Promise<boolean> {
  if (!(error instanceof ExecutionProgressError) || error.stage !== "settle" || error.code !== "effect_reconciliation_required"
    || currentPhase(engine) !== "turning" || !hasUnknownToolResult(engine)
    || unsettledToolCallCount(engine.state) !== 0 || engine.state.openToolInputIds.length !== 0) return false;

  const finish = inputs.find(input => input.type === "finish");
  if (finish === undefined) return false;

  await dispatch(engine, ports, finish);
  await reportInterruption(engine, ports, cancelled, "effect_reconciliation_required", run);
  return true;
}

/** Compare canonical output, excluding transient block and call identities. */
export function repeatedTruncation(engine: Engine, finish: ReduceInput | undefined, items: Transcript): boolean {
  if (finish?.type !== "finish" || finish.reason !== "length" || currentPhase(engine) === "terminal") {
    delete engine.lastTruncatedContent;
    return false;
  }

  const content = JSON.stringify(items.flatMap<JsonObject>(item => item.kind === "assistant_text" ? [{ kind: item.kind, text: item.text }]
    : item.kind === "assistant_reasoning" && !item.redacted ? [{ kind: item.kind, text: item.text }]
    : item.kind === "tool_call" ? [{ kind: item.kind, name: item.name, arguments: item.arguments }] : []));
  const repeated = content === engine.lastTruncatedContent;
  engine.lastTruncatedContent = content;
  return repeated;
}
