import { EXIT_CODES, type CliRunStatus, type CliUsage, type ExitCode } from "../../protocol/cli-stream.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { ProviderUsage } from "../../ports/provider.js";
import type { RunTurnResult } from "../../loop/runner.js";
import type { TurnOutcome, TurnFailure } from "./host.js";

/**
 * Reading a finished turn: what it used, how it ended, what that costs the
 * process.
 *
 * Split out of `host.ts` so that file stays under the file-size discipline; the
 * functions are pure, which is what makes the split safe — nothing here needs
 * the host's inputs, a clock or a session.
 *
 * The exit-code rule is the load-bearing one: codes come from *facts* (a
 * terminal state, a provider error class), never from message text. Parsing a
 * sentence to decide whether to retry is how "rate limited" and "wrong model"
 * end up with the same exit code.
 */

/** Provider failures that make a warm session unfit to reuse. */
export const UNREUSABLE_ERROR_CLASSES = new Set([
  "auth",
  "network",
  "server",
  "protocol",
  "timeout",
]);

export function isTurnFailure(value: TurnOutcome | TurnFailure): value is TurnFailure {
  return !("result" in value);
}

export function usageToCli(usage: ProviderUsage): CliUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function terminalStatusOf(result: RunTurnResult): CliRunStatus {
  if (result.state.phase !== "terminal") {
    return "unknown";
  }
  return result.state.terminalReason ?? "unknown";
}

/** The class the provider adapter reported, carried on the terminal envelope. */
export function providerErrorClass(envelopes: ReadonlyArray<Envelope>): string | undefined {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index];
    if (envelope === undefined || envelope.kind !== "terminal") {
      continue;
    }
    const value = envelope.payload.errorClass;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Exit codes from facts: a provider error class decides auth (41) and temporary
 * (75), and anything the run never settled is temporary so an outer caller may
 * retry it later.
 */
export function exitCodeForResult(result: RunTurnResult): ExitCode {
  if (result.state.phase !== "terminal") {
    return EXIT_CODES.TEMPORARY;
  }
  const status = terminalStatusOf(result);
  if (status === "completed") {
    return EXIT_CODES.OK;
  }
  if (status === "cancelled") {
    return EXIT_CODES.CANCELLED;
  }
  const errorClass = providerErrorClass(result.envelopes);
  if (errorClass === "auth") {
    return EXIT_CODES.AUTH;
  }
  if (
    errorClass === "rate_limit" ||
    errorClass === "server" ||
    errorClass === "network" ||
    errorClass === "timeout"
  ) {
    return EXIT_CODES.TEMPORARY;
  }
  return EXIT_CODES.EXECUTION_FAILURE;
}
