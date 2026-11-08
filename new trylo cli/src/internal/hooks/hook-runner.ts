/**
 * WP17 — firing one trigger through every selected hook.
 *
 * Arbitration only: select in stable order, run each hook once, merge the
 * evidence with `block > cancelled > allow` precedence. How a hook runs is
 * `hook-execution.ts`; what its answer means is `hook-decision.ts`.
 * There is deliberately no parallelism here (concurrency 1): hook side
 * effects are authorised one at a time, and a parallel runner would need an
 * effect-arbitration story this package does not own (WP22 does).
 */

import { systemTimerScheduler, type TimerScheduler } from "../subagent/scheduler.js";
import { selectHooks, type HookStore } from "./hook-config.js";
import type { HookVerdict } from "./hook-decision.js";
import { runOneHook } from "./hook-execution.js";
import type { HookRunnerDeps, HookTrigger } from "./hook-ports.js";

export type AggregatedHookResult = {
  readonly verdict: HookVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly additionalContexts: ReadonlyArray<string>;
  readonly updatedInputs: ReadonlyArray<unknown>;
  readonly hookErrors: ReadonlyArray<string>;
  readonly executedIds: ReadonlyArray<string>;
};

/**
 * Fires one trigger through every selected hook, once each, in order.
 *
 * An empty selection is an allow with empty evidence — "no hooks" and "hooks
 * approved" are different claims, and the empty arrays keep them apart.
 * `executedIds` lists every selected hook the runner produced a result for,
 * including hooks refused before start (their reason says so): it is
 * selection evidence, not proof a process ran.
 */
export async function runHooksForEvent(
  store: HookStore,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler = systemTimerScheduler,
): Promise<AggregatedHookResult> {
  const reasons: Array<string> = [];
  const additionalContexts: Array<string> = [];
  const updatedInputs: Array<unknown> = [];
  const hookErrors: Array<string> = [];
  const executedIds: Array<string> = [];
  let verdict: HookVerdict = "allow";
  const raise = (next: HookVerdict): void => {
    if (verdict === "block") {
      return;
    }
    if (next === "block" || verdict === "allow") {
      verdict = next;
    }
  };

  for (const hook of selectHooks(store, trigger.event, trigger.matchValue)) {
    const result = await runOneHook(hook, trigger, deps, schedule);

    executedIds.push(result.hookId);
    raise(result.verdict);

    if (result.reason !== undefined) {
      reasons.push(result.reason);
    }

    if (result.additionalContext !== undefined) {
      additionalContexts.push(result.additionalContext);
    }

    if (result.updatedInput !== undefined) {
      updatedInputs.push(result.updatedInput);
    }

    if (result.hookError !== undefined) {
      hookErrors.push(result.hookError);
    }
  }

  return { verdict, reasons, additionalContexts, updatedInputs, hookErrors, executedIds };
}
