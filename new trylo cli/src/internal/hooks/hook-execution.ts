/**
 * WP17.2 / WP17.3 — running one hook through its ports.
 *
 * This layer owns every effect: authorisation order, the abort re-check
 * after the gate await, timeouts, the URL allowlist, and the recursion
 * bound. It owns no verdict vocabulary — reading answers stays in
 * `hook-decision.ts` — and no aggregation: one hook in, one `HookResult`
 * out, selected and merged by `hook-runner.ts`.
 */

import { type TimerHandle, type TimerScheduler } from "../subagent/scheduler.js";
import type { HookConfig } from "./hook-config.js";
import {
  interpretCommandResult,
  interpretHttpResponse,
  interpretModelAnswer,
  type HookResult,
} from "./hook-decision.js";
import type { HookRunnerDeps, HookTrigger } from "./hook-ports.js";

/** How deep prompt/agent hooks may nest before the runner refuses. */
export const DEFAULT_HOOK_MAX_DEPTH = 3;

type DeadlineOutcome<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

/**
 * Settles `work` against a timeout and an abort signal.
 *
 * Rejection is its own outcome (`failed`), never confused with cancellation:
 * a port that threw is "unknown", and the caller maps that to `cancelled`
 * rather than guessing allow or block on its behalf.
 */
function raceDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  schedule: TimerScheduler,
  signal: AbortSignal,
): Promise<DeadlineOutcome<T>> {
  if (signal.aborted) {
    return Promise.resolve({ kind: "aborted" });
  }
  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let settled = false;
    let timer: TimerHandle | undefined;
    const finish = (outcome: DeadlineOutcome<T>): void => {
      if (settled) {
        return;
      }

      settled = true;
      timer?.cancel();
      signal.removeEventListener("abort", onAbortSignal);
      resolve(outcome);
    };
    const onAbortSignal = (): void => {
      finish({ kind: "aborted" });
    };

    timer = schedule(Math.max(0, timeoutMs), () => {
      finish({ kind: "timeout" });
    });
    signal.addEventListener("abort", onAbortSignal, { once: true });
    work.then(
      (value) => {
        finish({ kind: "completed", value });
      },
      (error: unknown) => {
        finish({ kind: "failed", error });
      },
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

type SettledPort<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "stop"; readonly result: HookResult };

/**
 * The one mapping from "the port did not answer" to a hook verdict.
 *
 * Timeout, abort, and port failure all mean the runner stopped knowing — so
 * all three are `cancelled`, never a guessed allow or block. The port name
 * keeps the reason attributable (`command executor` vs `http transport` vs
 * model ports) without a fourth copy of the mapping.
 */
async function settleHookPort<T>(
  hookId: string,
  portName: string,
  timeoutMs: number,
  work: Promise<T>,
  signal: AbortSignal,
  schedule: TimerScheduler,
): Promise<SettledPort<T>> {
  const outcome = await raceDeadline(work, timeoutMs, schedule, signal);
  switch (outcome.kind) {
    case "completed":
      return { kind: "value", value: outcome.value };
    case "aborted":
      return { kind: "stop", result: { hookId, verdict: "cancelled", reason: `hook ${hookId} aborted` } };
    case "timeout":
      return {
        kind: "stop",
        result: { hookId, verdict: "cancelled", reason: `hook ${hookId} timed out after ${timeoutMs}ms` },
      };
    case "failed":
      return {
        kind: "stop",
        result: { hookId, verdict: "cancelled", reason: `hook ${hookId} ${portName} failed: ${errorMessage(outcome.error)}` },
      };
  }
}

/**
 * Refuses a hook before it touches any port.
 *
 * `raceDeadline` also checks the signal, but arguments evaluate first: by the
 * time it saw an aborted signal, `deps.command.run(...)` would already have
 * been invoked. Authorisation and spawning happen only past this guard — and
 * past the second check after the gate await (`runCommandHook`).
 */
function refusedBeforeStart(hookId: string, signal: AbortSignal): HookResult | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  return { hookId, verdict: "cancelled", reason: `hook ${hookId} aborted before start` };
}

function stdinFor(trigger: HookTrigger): string {
  return JSON.stringify({ event: trigger.event, matchValue: trigger.matchValue, data: trigger.data });
}

export function urlMatchesAllowlist(url: string, patterns: ReadonlyArray<string>): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  for (const pattern of patterns) {
    if (pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*")) {
      if (url.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (url === pattern) {
      return true;
    }
  }

  return false;
}

function depthOf(trigger: HookTrigger, configured: number | undefined): number {
  // The hook's own bound may only tighten the caller's ceiling, never widen
  // it: Math.min, not ??. A hook that could raise the bound could unbound
  // itself, and the bound is the only guard against hook-triggered recursion.
  return Math.min(configured ?? Number.POSITIVE_INFINITY, trigger.maxDepth ?? DEFAULT_HOOK_MAX_DEPTH);
}

async function runCommandHook(
  hook: Extract<HookConfig, { kind: "command" }>,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler,
): Promise<HookResult> {
  if (hook.command.length === 0) {
    return { hookId: hook.id, verdict: "allow", hookError: `hook ${hook.id} declares an empty command` };
  }

  const refused = refusedBeforeStart(hook.id, trigger.signal);
  if (refused !== undefined) {
    return refused;
  }

  let authorised: boolean;

  try {
    const decision = await deps.gate.authorizeHookCommand(hook.command, trigger.event);
    authorised = decision.verdict === "approved";
    if (!authorised) {
      const refusal = decision.verdict === "denied" ? decision.reason : "hook authorisation unavailable";
      return { hookId: hook.id, verdict: "block", reason: refusal };
    }
  } catch (error: unknown) {
    // The gate itself failed: nothing ran, and the task must not proceed as
    // if it had been authorised.
    return { hookId: hook.id, verdict: "cancelled", reason: `hook ${hook.id} authorisation failed: ${errorMessage(error)}` };
  }

  if (trigger.signal.aborted) {
    // The gate await is the one window where cancellation can arrive after
    // the pre-start check: the executor call below evaluates eagerly, so
    // re-check here, before any spawn, not inside the deadline race.
    return { hookId: hook.id, verdict: "cancelled", reason: `hook ${hook.id} aborted during authorisation` };
  }

  const settled = await settleHookPort(
    hook.id,
    "command executor",
    hook.timeoutMs,
    deps.command.run(hook.command, stdinFor(trigger), { timeoutMs: hook.timeoutMs, signal: trigger.signal }),
    trigger.signal,
    schedule,
  );
  if (settled.kind === "stop") {
    return settled.result;
  }

  return interpretCommandResult(hook.id, settled.value);
}

async function runHttpHook(
  hook: Extract<HookConfig, { kind: "http" }>,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler,
): Promise<HookResult> {
  if (!urlMatchesAllowlist(hook.url, hook.allowedUrlPatterns)) {
    return {
      hookId: hook.id,
      verdict: "allow",
      hookError: `hook ${hook.id} url is not allowlisted: ${hook.url}`,
    };
  }

  const httpRefused = refusedBeforeStart(hook.id, trigger.signal);
  if (httpRefused !== undefined) {
    return httpRefused;
  }

  const settled = await settleHookPort(
    hook.id,
    "http transport",
    hook.timeoutMs,
    deps.http.post(hook.url, stdinFor(trigger), { timeoutMs: hook.timeoutMs, signal: trigger.signal }),
    trigger.signal,
    schedule,
  );
  if (settled.kind === "stop") {
    return settled.result;
  }

  return interpretHttpResponse(hook.id, settled.value);
}

async function runPromptHook(
  hook: Extract<HookConfig, { kind: "prompt" }>,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler,
): Promise<HookResult> {
  if (trigger.depth >= depthOf(trigger, hook.maxDepth)) {
    return { hookId: hook.id, verdict: "cancelled", reason: `hook ${hook.id} recursion bound reached at depth ${trigger.depth}` };
  }

  const promptRefused = refusedBeforeStart(hook.id, trigger.signal);
  if (promptRefused !== undefined) {
    return promptRefused;
  }

  const settled = await settleHookPort(
    hook.id,
    "prompt port",
    hook.timeoutMs,
    deps.prompt.ask({ prompt: hook.prompt, event: trigger.event, matchValue: trigger.matchValue }, { timeoutMs: hook.timeoutMs, signal: trigger.signal }),
    trigger.signal,
    schedule,
  );
  if (settled.kind === "stop") {
    return settled.result;
  }

  return interpretModelAnswer(hook.id, settled.value);
}

async function runAgentHook(
  hook: Extract<HookConfig, { kind: "agent" }>,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler,
): Promise<HookResult> {
  if (trigger.depth >= depthOf(trigger, hook.maxDepth)) {
    return { hookId: hook.id, verdict: "cancelled", reason: `hook ${hook.id} recursion bound reached at depth ${trigger.depth}` };
  }

  const agentRefused = refusedBeforeStart(hook.id, trigger.signal);
  if (agentRefused !== undefined) {
    return agentRefused;
  }

  const settled = await settleHookPort(
    hook.id,
    "agent port",
    hook.timeoutMs,
    deps.agent.run(
      { task: hook.task, event: trigger.event, matchValue: trigger.matchValue, maxTurns: hook.maxTurns },
      { timeoutMs: hook.timeoutMs, signal: trigger.signal },
    ),
    trigger.signal,
    schedule,
  );
  if (settled.kind === "stop") {
    return settled.result;
  }

  const answer = settled.value;
  if (answer.turnsUsed > hook.maxTurns) {
    return { hookId: hook.id, verdict: "cancelled", reason: `hook ${hook.id} exceeded ${hook.maxTurns} turns` };
  }

  return interpretModelAnswer(hook.id, answer);
}

export function runOneHook(
  hook: HookConfig,
  trigger: HookTrigger,
  deps: HookRunnerDeps,
  schedule: TimerScheduler,
): Promise<HookResult> {
  switch (hook.kind) {
    case "command":
      return runCommandHook(hook, trigger, deps, schedule);
    case "http":
      return runHttpHook(hook, trigger, deps, schedule);
    case "prompt":
      return runPromptHook(hook, trigger, deps, schedule);
    case "agent":
      return runAgentHook(hook, trigger, deps, schedule);
  }
}
