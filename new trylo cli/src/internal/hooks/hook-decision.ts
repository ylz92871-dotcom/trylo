/**
 * WP17 — reading what hooks say.
 *
 * This layer turns bytes back into verdicts and nothing else: the JSON
 * dialects both baselines emit, the old-CLI exit-code contract, the HTTP
 * status contract, and the model-answer contract. It never runs anything,
 * authorises anything, or touches a clock — so its tests need no ports at
 * all, only strings and status codes.
 */

import type {
  HookAgentAnswer,
  HookCommandResult,
  HookHttpResponse,
  HookPromptAnswer,
} from "./hook-ports.js";

export type HookVerdict = "allow" | "block" | "cancelled";

export type HookResult = {
  readonly hookId: string;
  readonly verdict: HookVerdict;
  readonly reason?: string | undefined;
  readonly additionalContext?: string | undefined;
  readonly updatedInput?: unknown | undefined;
  readonly hookError?: string | undefined;
};

export type InterpretedOutput = {
  readonly block: boolean;
  readonly reason?: string | undefined;
  readonly additionalContext?: string | undefined;
  readonly updatedInput?: unknown | undefined;
};

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads one hook's JSON answer in every dialect the baselines emit.
 *
 * Block if any dialect says so: `{decision:"block"}` (old CLI),
 * `{continue:false}` (Codex command output), `{ok:false}` (old CLI
 * prompt/agent). Context comes from `additionalContext` or Codex's
 * `hookSpecificOutput.additionalContext`. Anything that is valid JSON but
 * carries no decision is observed, not rejected — a hook that chats is not a
 * hook that failed.
 */
export function interpretJsonDecision(parsed: unknown): InterpretedOutput {
  if (typeof parsed === "string") {
    return parsed === "" ? { block: false } : { block: false, additionalContext: parsed };
  }

  if (!isJsonRecord(parsed)) {
    return { block: false };
  }

  const decision = readString(parsed, "decision");
  const ok = parsed["ok"];
  const cont = parsed["continue"];
  const block = decision === "block" || decision === "deny" || cont === false || ok === false;
  const reason = readString(parsed, "reason") ?? readString(parsed, "stopReason");
  const nested: unknown = parsed["hookSpecificOutput"];
  const nestedContext =
    isJsonRecord(nested) && typeof nested["additionalContext"] === "string"
      ? nested["additionalContext"]
      : undefined;
  const additionalContext = readString(parsed, "additionalContext") ?? nestedContext;
  const updatedInput: unknown = parsed["updatedInput"];

  return {
    block,
    ...(reason === undefined ? {} : { reason }),
    ...(additionalContext === undefined ? {} : { additionalContext }),
    ...(updatedInput === undefined ? {} : { updatedInput }),
  };
}

export function interpretTextOutput(stdout: string): InterpretedOutput {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return { block: false };
  }

  try {
    return interpretJsonDecision(JSON.parse(trimmed));
  } catch {
    // Not JSON: the hook printed text, so the task sees the text. Treating
    // unparsable output as a failure would punish every `echo` hook.
    return { block: false, additionalContext: trimmed };
  }
}

export function allowWith(hookId: string, interpreted: InterpretedOutput): HookResult {
  if (interpreted.block) {
    return {
      hookId,
      verdict: "block",
      reason: interpreted.reason ?? `hook ${hookId} blocked`,
      ...(interpreted.additionalContext === undefined ? {} : { additionalContext: interpreted.additionalContext }),
      ...(interpreted.updatedInput === undefined ? {} : { updatedInput: interpreted.updatedInput }),
    };
  }
  return {
    hookId,
    verdict: "allow",
    ...(interpreted.additionalContext === undefined ? {} : { additionalContext: interpreted.additionalContext }),
    ...(interpreted.updatedInput === undefined ? {} : { updatedInput: interpreted.updatedInput }),
  };
}

/**
 * The old-CLI shell convention, kept: `0` = observe or inject (stdout
 * decides), `2` = block, anything else = the hook itself failed and the task
 * continues with the failure recorded.
 */
export function interpretCommandResult(hookId: string, result: HookCommandResult): HookResult {
  if (result.timedOut) {
    return { hookId, verdict: "cancelled", reason: `hook ${hookId} timed out` };
  }

  if (result.exitCode === 2) {
    // The question is only whether a reason was parsed — not whether any
    // field was. Plain text parses into additionalContext, and treating that
    // as "a reason exists" silently kills the stderr fallback below (2026-10-06
    // review regression). Context without a reason is not a reason.
    const interpreted = interpretTextOutput(result.stdout);
    if (interpreted.reason !== undefined) {
      return allowWith(hookId, { ...interpreted, block: true });
    }

    const reason = result.stderr.trim() === "" ? result.stdout.trim() : result.stderr.trim();

    return { hookId, verdict: "block", reason: reason === "" ? `hook ${hookId} blocked` : reason };
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() === "" ? result.stdout.trim() : result.stderr.trim();
    return {
      hookId,
      verdict: "allow",
      hookError: `hook ${hookId} exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
    };
  }

  return allowWith(hookId, interpretTextOutput(result.stdout));
}

export function interpretHttpResponse(hookId: string, response: HookHttpResponse): HookResult {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { hookId, verdict: "allow", hookError: `hook ${hookId} answered HTTP ${response.statusCode}` };
  }
  return allowWith(hookId, interpretTextOutput(response.body));
}

export function interpretModelAnswer(hookId: string, answer: HookPromptAnswer | HookAgentAnswer): HookResult {
  if (!answer.ok) {
    return { hookId, verdict: "block", reason: answer.reason };
  }
  return {
    hookId,
    verdict: "allow",
    ...(answer.additionalContext === undefined ? {} : { additionalContext: answer.additionalContext }),
  };
}
