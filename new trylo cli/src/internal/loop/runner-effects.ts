import type { EffectCommand } from "../domain/command.js";
import type { ReduceInput } from "../domain/input.js";
import { createParallelGate, type ParallelGate } from "../domain/parallel-gate.js";
import { reduce } from "../domain/reduce.js";
import { settlementOrder } from "../domain/tool-batch.js";
import type { ExecutionState } from "../domain/state.js";
import type { ToolOutcome } from "../ports/tools.js";
import { toolHostFor, type ViewDeps } from "./host-views.js";
import { emitRaw, nextId } from "./journal-emit.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";
import { cancelToolSafely, readToolApprovalRequirement } from "./tool-boundary.js";
import { executeToolOnly, settleToolOutcome, type ToolExecutionCall } from "./tool-execution.js";
import { runPermission, runTool, type ToolRunnerHost } from "./tool-runner.js";
import { flushProgress, issueEffect, settleEffect } from "./progress.js";
import { executableStreamInputs } from "./stream-verdict.js";

/**
 * What a reducer command *does*, once the turn loop has decided it exists.
 *
 * These five pieces were the second half of `runner.ts` — the half that talks
 * to ports — and they sit out here for the same reason `runner-engine.ts` does:
 * a file that reads as one thing (here: an effect command becoming side
 * effects) beats a file that carries two things and a 500-line rule.
 *
 * `dispatch` is the hinge. It is the only writer of `engine.state`, so every
 * mutation of a turn flows through the reducer and its command list; the loop
 * above never assigns state and never calls a port directly.
 */

/**
 * Reads the phase through a call boundary: narrowing survives `await`, so a
 * direct `engine.state.phase` read after a dispatch would be treated as
 * unchanged by the very dispatches that mutate it.
 */
export function currentPhase(engine: Engine): ExecutionState["phase"] {
  return engine.state.phase;
}

/** Tool calls issued but not yet settled: running or still awaiting permission. */
export function unsettledToolCallCount(state: ExecutionState): number {
  return Object.values(state.toolCalls).filter(
    (call) => call.status === "executing" || call.status === "awaiting_permission",
  ).length;
}

/**
 * Apply one stream's inputs in order, holding the `finish` back.
 *
 * The hold is the point: a `finish` says the provider stopped talking, not that
 * the tools it asked for have settled, and the turn must not end on a promise
 * that is still running. This returns it so the caller can apply it after
 * settlement — which is also why nothing here dispatches it early.
 *
 * A response that asks for *several* tools is one scheduling unit, and that is
 * why registration and execution come apart here. Registering a call and
 * running it in the same step cannot survive a second call: the first result
 * settles, the phase returns to `turning`, and the sibling that has not been
 * registered yet is then an illegal transition. So for a multi-call response
 * every request is folded into the batch first — commands collected, nothing
 * run — and only once the whole response is registered are those commands
 * interpreted in the order the provider gave them. A response with a single
 * call keeps the historical one-step path untouched.
 */
export async function applyStreamInputs(
  engine: Engine,
  ports: LoopPorts,
  inputs: ReadonlyArray<ReduceInput>,
): Promise<ReduceInput | undefined> {
  const executable = executableStreamInputs(inputs);
  let finish: ReduceInput | undefined;
  // Counted by distinct call id, not by input: a response is "multi-tool" when
  // it asks for more than one *call*, and a repeated fact about one call is not
  // a second call.
  const calls = new Set(
    executable.flatMap((input) => (input.type === "tool_request" ? [input.toolCallId] : [])),
  );
  const batched = calls.size > 1;
  const deferred: EffectCommand[] = [];
  for (const input of executable) {
    if (input.type === "finish") {
      finish = input;
      continue;
    }
    if (input.type === "tool_request") {
      const approval = readToolApprovalRequirement(ports.tools, input.name, input, ports.sandbox, ports.permission);
      if (approval.degradedReason !== undefined) {
        emitRaw(engine, "observation", {
          degraded: true,
          reason: approval.degradedReason,
          component: "tool_snapshot",
        });
      }
      const request: ReduceInput = { ...input, needsApproval: approval.required };
      if (batched) {
        const commands = await applyToState(engine, { ...request, batch: true });
        if (commands !== undefined) {
          deferred.push(...commands);
        }
      } else {
        await dispatch(engine, ports, request);
      }
      continue;
    }
    await dispatch(engine, ports, input);
    if (input.type === "text_delta" && engine.cancelAfter === "streaming" && !engine.sawText) {
      engine.sawText = true;
      await dispatch(engine, ports, { type: "cancel", eventId: nextId(engine) });
    }
  }
  await runDeferred(engine, ports, deferred);
  return finish;
}

/**
 * Runs the commands a multi-call response produced, in the order the provider
 * asked for them.
 *
 * A run of consecutive `execute_tool` commands is one scheduling unit and goes
 * to `runExecutionsTogether`; anything else — a permission request above all —
 * keeps the historical one-at-a-time path. Permission is left alone on purpose:
 * two questions asked at once consume each other's answers, and a permission
 * prompt is a conversation with one person, not a task to overlap.
 */
async function runDeferred(
  engine: Engine,
  ports: LoopPorts,
  commands: ReadonlyArray<EffectCommand>,
): Promise<void> {
  let pending: ExecutionCommand[] = [];
  const flush = async (): Promise<void> => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) {
      return;
    }
    // One execution is the historical single-call shape and gains nothing from
    // a gate, so it keeps its original path byte for byte.
    if (batch.length === 1) {
      const only = batch[0];
      if (only !== undefined) {
        await interpret(engine, ports, only);
      }
      return;
    }
    await runExecutionsTogether(engine, ports, batch);
  };
  for (const command of commands) {
    if (command.type === "execute_tool") {
      pending.push(command);
      continue;
    }
    // A `tool_use` envelope only records that the call was asked for; it is
    // written as it arrives and does not split the batch. Splitting on it would
    // leave every batch one call long, because a response alternates
    // emit/execute per call — and the gate would never have two calls to
    // arbitrate.
    if (command.type === "emit") {
      await interpret(engine, ports, command);
      continue;
    }
    // Anything else is a conversation with something outside the batch — a
    // permission request above all, which is one person's answer and must not
    // race a sibling. The batch that came before it is finished first.
    await flush();
    await interpret(engine, ports, command);
  }
  await flush();
}

type ExecutionCommand = Extract<EffectCommand, { type: "execute_tool" }>;

/**
 * Executes one batch of tool calls concurrently and settles them in id order.
 *
 * The split is the whole point. Calls run together because waiting for a slow
 * read before starting the next one is the delay this shape exists to remove;
 * results are written in `settlementOrder` because the journal is a record, and
 * a record whose order depends on which call happened to finish first cannot be
 * replayed or compared (`domain/tool-batch.ts`).
 *
 * Which calls may overlap is decided by the gate, not here: a tool that
 * declared `parallelSafe` takes the shared lock, anything else takes the
 * exclusive one, so a batch of mixed tools is safe without this code knowing
 * which of them writes.
 */
async function runExecutionsTogether(
  engine: Engine,
  ports: LoopPorts,
  commands: ReadonlyArray<ExecutionCommand>,
): Promise<void> {
  const host = toolHostFor(engine, ports, views);
  const gate = createParallelGate();
  const runs = commands
    .filter((command) => !engine.committed.has(command.idempotencyKey))
    .map((command) => ({ command, call: executionCallOf(host, command.toolCallId) }));

  // Progress opens for every member, in the provider's order, before any of
  // them runs: a batch that reported its first "started" after the others had
  // already finished would read as a queue, not as concurrency.
  for (const run of runs) {
    engine.issued.add(run.command.idempotencyKey);
    await issueEffect(engine, ports, run.command.idempotencyKey);
  }

  const outcomes = new Map<string, Promise<ToolOutcome>>();
  for (const run of runs) {
    outcomes.set(run.command.toolCallId, executeUnderGate(ports, gate, host, run.call));
  }

  for (const toolCallId of settlementOrder([...outcomes.keys()])) {
    const run = runs.find((item) => item.command.toolCallId === toolCallId);
    const pending = outcomes.get(toolCallId);
    if (run === undefined || pending === undefined) {
      continue;
    }
    if (run.call === undefined) {
      await host.dispatch({
        type: "tool_unknown",
        eventId: host.nextEventId(),
        toolCallId,
        message: "unknown_tool_call",
      });
    } else {
      await settleToolOutcome(host, run.call, await pending);
    }
    await settleEffect(engine, ports, run.command.idempotencyKey, toolCallId);
    engine.committed.add(run.command.idempotencyKey);
  }
  await flushProgress(engine, ports);
}

function executionCallOf(host: ToolRunnerHost, toolCallId: string): ToolExecutionCall | undefined {
  const call = host.callFor(toolCallId);
  return call === undefined
    ? undefined
    : { toolCallId, name: call.name, arguments: call.arguments };
}

/**
 * One call under the gate. The lock is held across the execution only — never
 * across the settling — because the results are written later and in order;
 * holding it longer would make the batch a queue again.
 */
async function executeUnderGate(
  ports: LoopPorts,
  gate: ParallelGate,
  host: ToolRunnerHost,
  call: ToolExecutionCall | undefined,
): Promise<ToolOutcome> {
  if (call === undefined) {
    return { outcome: "unknown", code: "unknown_tool_call", message: "unknown_tool_call" };
  }
  const binding = ports.tools.snapshot().find((item) => item.name === call.name);
  const release = await (binding?.parallelSafe === true ? gate.read() : gate.write());
  try {
    if (binding?.sideEffect === "workspace_write") {
      await host.beforeWrite(call.name);
    }
    return await executeToolOnly(ports.tools, call, host.abortSignal);
  } finally {
    release();
  }
}

/**
 * The one way a turn's state changes: an input goes to the reducer, and every
 * command the reducer produced is interpreted before the next input is read.
 *
 * Recording the input *before* reducing it is what keeps a replay faithful:
 * a journal that only kept the commands would be unable to say which input
 * produced them.
 */
export async function dispatch(engine: Engine, ports: LoopPorts, input: ReduceInput): Promise<void> {
  const commands = await applyToState(engine, input);
  if (commands === undefined) {
    return;
  }
  for (const command of commands) {
    await interpret(engine, ports, command);
  }
  await flushProgress(engine, ports);
}

/**
 * The reducer half of a dispatch, without the side effects.
 *
 * It exists for the one caller that has to see a whole response's commands
 * before any of them runs (`applyStreamInputs`); `undefined` means the input was
 * refused and has already been reported as an error, so the caller has nothing
 * to interpret.
 */
async function applyToState(
  engine: Engine,
  input: ReduceInput,
): Promise<ReadonlyArray<EffectCommand> | undefined> {
  const delivered = engine.journal.recordInput(input);
  const result = reduce(engine.state, delivered);
  engine.state = result.state;
  if (!result.ok) {
    emitRaw(engine, "error", {
      code: result.error.code,
      message: result.error.message,
    });
    return undefined;
  }
  if (
    engine.state.currentAttemptId !== undefined &&
    engine.state.currentAttemptId !== engine.boundAttempt
  ) {
    engine.journal.bindAttempt(engine.state.currentAttemptId);
    engine.boundAttempt = engine.state.currentAttemptId;
  }
  return result.commands;
}

async function interpret(engine: Engine, ports: LoopPorts, command: EffectCommand): Promise<void> {
  if (engine.committed.has(command.idempotencyKey)) {
    return;
  }
  engine.issued.add(command.idempotencyKey);
  switch (command.type) {
    case "emit":
      emitRaw(engine, command.kind, command.payload);
      engine.committed.add(command.idempotencyKey);
      return;
    case "stream_provider":
      // Streams are opened by the turn loop, never by a reducer command: a
      // stream nested inside another stream's input handling would lose the
      // ordering guarantees the loop exists to provide.
      emitRaw(engine, "error", {
        code: "illegal_transition",
        message: "stream_provider_outside_iteration_loop",
      });
      engine.committed.add(command.idempotencyKey);
      return;
    case "cancel_provider":
      engine.abort.abort();
      engine.committed.add(command.idempotencyKey);
      return;
    case "request_permission":
      await runPermission(toolHostFor(engine, ports, views), ports, command.toolCallId, command.name);
      engine.committed.add(command.idempotencyKey);
      return;
    case "execute_tool":
      await issueEffect(engine, ports, command.idempotencyKey);
      await runTool(toolHostFor(engine, ports, views), ports.tools, command.toolCallId);
      await settleEffect(engine, ports, command.idempotencyKey, command.toolCallId);
      engine.committed.add(command.idempotencyKey);
      return;
    case "cancel_tool": {
      const cancelled = await cancelToolSafely(ports.tools, command.toolCallId);
      if (!cancelled.ok) {
        emitRaw(engine, "observation", {
          component: "tool_cancel",
          status: "failed",
          toolCallId: command.toolCallId,
          message: cancelled.message,
        });
      }
      engine.committed.add(command.idempotencyKey);
      return;
    }
    default: {
      const _never: never = command;
      emitRaw(engine, "error", { code: "illegal_transition", message: String(_never) });
    }
  }
}

/**
 * The one thing the moved-out host views need from here: the dispatcher that
 * closes the loop between an effect command and the input it produces. Injecting
 * it is what keeps `host-views.ts` from having to import this module at runtime.
 */
export const views: ViewDeps = { dispatch };
