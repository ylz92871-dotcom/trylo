import type { IterationDecision } from "../domain/iteration.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";
import { nextTranscriptSequence } from "./transcript-messages.js";
import { flushProgress } from "./progress.js";
import { dispatch } from "./runner-effects.js";
import { nextId } from "./journal-emit.js";

export async function stopInactiveGoal(engine: Engine, ports: LoopPorts): Promise<boolean> {
  const status = ports.goal?.current().status;
  if (status === undefined || status === "active" || status === "complete") return false;
  await dispatch(engine, ports, status === "cancelled" ? { type: "cancel", eventId: nextId(engine) }
    : { type: "turn_failed", eventId: nextId(engine), reason: `waiting:goal_${status}` });
  return true;
}

/** The goal owns its cumulative usage watermark; every execution exit uses
 * this same acknowledged boundary before deciding whether another request fits. */
export async function checkpointGoal(engine: Engine, ports: LoopPorts): Promise<void> {
  if (ports.goal === undefined) return;

  await flushProgress(engine, ports);
  await ports.goal.checkpoint(engine.usage.totalTokens, engine.state.turnId, engine.iterations);
}

/** A system continuation cannot enqueue a user input or refund any budget. */
export async function goalBoundary(engine: Engine, ports: LoopPorts, decision: IterationDecision, purpose: "work" | "final_report"): Promise<IterationDecision> {
  const goal = ports.goal;
  if (goal === undefined) return decision;

  // The checkpoint must follow the model/tool facts it summarizes, including
  // a completion tool result; otherwise replay could overwrite billed usage.
  await checkpointGoal(engine, ports);
  const status = goal.current().status;

  // Completion disables automatic prompting; it cannot erase a failed
  // iteration or a normal follow-up/input debt the execution loop still owns.
  if (status === "complete" || decision.kind === "fail") return decision;

  if (status !== "active") return { kind: "wait", reason: "user_input" };

  if (purpose !== "work" || decision.kind !== "complete") return decision;

  engine.transcript = [...engine.transcript, { kind: "system", sequence: nextTranscriptSequence(engine.transcript), text: goal.reminder() }];

  return { kind: "continue", reason: "goal_active" };
}
