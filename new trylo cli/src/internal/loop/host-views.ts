import type { ReduceInput } from "../domain/input.js";
import { snapshotBeforeWrite } from "./checkpoint-gate.js";
import { feedTurnDiffFromOutcome } from "./turn-diff-feed.js";
import { promptContextFor, runCompactionFor, type CompactionGapOutcome } from "./compact-boundary.js";
import type { GapHost } from "./iteration-gap.js";
import { emitRaw, nextId } from "./journal-emit.js";
import type { LoopPorts } from "./runner.js";
import type { Engine } from "./runner-engine.js";
import { appendToolResult } from "./transcript-append.js";
import { nextTranscriptSequence } from "./transcript-messages.js";
import type { ToolRunnerHost } from "./tool-runner.js";
import { evaluateBudget } from "../domain/iteration.js";
import { authoringContext, auxiliarySpendingUnavailable, chargeAuxiliaryUsage } from "./auxiliary-usage.js";
import { flushProgress } from "./progress.js";

/**
 * The narrow views of the engine that its collaborators are allowed to hold.
 *
 * `tool-runner.ts` and the iteration-gap helpers must not see the engine itself
 * — they may emit, dispatch and read the few facts they need, and nothing else.
 * These builders are where that narrowing is written down, and they live here
 * rather than in `runner.ts` so the runner keeps its frozen line budget (the two
 * size gates in `exec-substrate-discipline.test.ts` and
 * `method-line-budget.test.ts`: "split something out", never "widen the
 * ceiling").
 *
 * The only thing they need from the runner is its dispatcher — the function that
 * closes the loop between an effect command and the input that command produces.
 * It is injected rather than imported, because importing it would make this
 * module and `runner.ts` depend on each other at runtime.
 */

export type ViewDeps = {
  readonly dispatch: (engine: Engine, ports: LoopPorts, input: ReduceInput) => Promise<void>;
};

/** The view of the engine that `tool-runner.ts` may touch; nothing else. */
export function toolHostFor(engine: Engine, ports: LoopPorts, deps: ViewDeps): ToolRunnerHost {
  return {
    emit: (kind, payload) => emitRaw(engine, kind, payload),
    dispatch: (input) => deps.dispatch(engine, ports, input),
    nextEventId: () => nextId(engine),
    callFor: (toolCallId) => engine.state.toolCalls[toolCallId],
    recordResult: (item) => {
      engine.transcript = appendToolResult(engine.transcript, item);
    },
    grants: engine.grants,
    doom: engine.doom,
    abortSignal: engine.abort.signal,
    noteTurnDiff: (_tool, value) => feedTurnDiffFromOutcome(engine.turnDiff, value),
    beforeWrite: (name) =>
      ports.checkpoint === undefined
        ? Promise.resolve()
        : snapshotBeforeWrite(
            {
              ...ports.checkpoint,
              signal: engine.compactionSignal,
              report: (payload) => emitRaw(engine, "observation", payload),
              state: engine.checkpoint,
            },
            name,
          ),
  };
}

/** Replacing history at the gap: emitted here, and returned for the caller's verdict. */
export async function emitCompactionFor(
  engine: Engine,
  ports: LoopPorts,
  options?: { readonly force?: boolean; readonly phase?: "preparing_request" },
): Promise<CompactionGapOutcome> {
  const verdict = evaluateBudget({ iterations: Math.max(0, engine.iterations - (options?.phase === "preparing_request" ? 1 : 0)),
    promptTokens: 0, outputTokens: engine.usage.outputTokens, costUsd: engine.costUsd }, engine.budget);
  const refused = auxiliarySpendingUnavailable(engine.auxiliary, engine.budget) ? "auxiliary_usage_unavailable"
    : verdict.kind === "within_budget" ? undefined : verdict.kind;
  if (refused !== undefined) return { events: [], storedWindow: false, projectedPromptTokens: undefined };

  const outcome = await runCompactionFor(promptContextFor(engine, ports.compaction, ports.tools), {
    ...options, signal: engine.compactionSignal,
    authoring: authoringContext(engine.usage, engine.budget, async receipt => {
      chargeAuxiliaryUsage(engine, receipt);
      emitRaw(engine, "observation", { component: "auxiliary_usage", operation: "summary_request", ...receipt });
      await flushProgress(engine, ports);
    }), onStart: tokensBefore => emitRaw(engine, "observation", {
      component: "compaction", status: "started", tokensBefore,
    }),
  });

  // The next-request ceiling uses the current view, including native fields,
  // even when the last stream omitted usage or summary authoring was refused.
  if (outcome.projectedPromptTokens !== undefined) engine.promptTokens = outcome.projectedPromptTokens;

  for (const event of outcome.events) {
    emitRaw(engine, event.kind, event.payload);
  }

  return outcome;
}

/** The view of the engine the gap helpers may touch; nothing else. */
export function gapHostFor(engine: Engine, ports: LoopPorts, deps: ViewDeps): GapHost {
  return {
    // The same fresh read `runner.ts` calls `currentPhase`: narrowing does not
    // survive an `await`, so every phase question is asked through a call.
    phase: () => engine.state.phase,
    // Asked in the name of the turn that is asking: a host whose words belong to
    // another turn says so by handing nothing over. A turn with no name of its
    // own has no claim on anybody's words either, so it is not offered any.
    pending: () => {
      const turnId = engine.state.turnId;
      return turnId === undefined ? [] : ports.pendingInput?.(turnId) ?? [];
    },
    queue: () => engine.queue,
    setQueue: (queue) => {
      engine.queue = queue;
    },
    setAside: (items) => {
      engine.setAsideInput = [...engine.setAsideInput, ...items];
    },
    forgiveBudget: () => {
      const limit = engine.budget.maxIterations;
      if (limit === undefined) return;

      // A steer refunds the steps already spent, out of an allowance no larger
      // than one turn's budget: redirecting a run may double it, never unbind
      // it. The refund is what was actually spent, so a steer at a gap where
      // nothing had been spent yet costs nothing and grants nothing.
      const allowance = Math.max(0, limit - engine.refunded);
      const refund = Math.min(engine.iterations, allowance);

      engine.iterations -= refund;
      engine.refunded += refund;
    },
    dispatch: (input) => deps.dispatch(engine, ports, input),
    nextEventId: () => nextId(engine),
    appendUser: (text) => {
      engine.transcript = [
        ...engine.transcript,
        { kind: "user", sequence: nextTranscriptSequence(engine.transcript), text },
      ];
    },
  };
}
