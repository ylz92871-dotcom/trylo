import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CheckLearnOptions } from "./args-check-learning.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { createStandaloneCheckRuntime } from "./check-learning-session.js";
import { dispatchCheckLearningOperation, prepareCheckLearningOperation,
  type CheckLearningOperation } from "../../learning/agent/subsystems/check/index.js";

export type { CheckLearningOperation } from "../../learning/agent/subsystems/check/index.js";

/** Also serves the JSON management script; it has no independent credential, home or permission policy. */
export async function runCheckLearningOperation(ctx: CliContext, operation: CheckLearningOperation, signal: AbortSignal,
  run: RunCommandOptions = { message: [], readStdin: false }) {
  if (signal.aborted) return { exitCode: EXIT_CODES.CANCELLED, result: { ok: false, code: "cancelled", message: "checker operation cancelled before dispatch" } };

  const prepared = prepareCheckLearningOperation(operation);
  if (prepared !== undefined) return { exitCode: prepared.ok ? EXIT_CODES.OK : EXIT_CODES.USAGE, result: prepared };

  const service = createStandaloneCheckRuntime(ctx, run, operation.action === "learn" ? "learn" : "manage");
  if ("exitCode" in service) return { exitCode: service.exitCode, result: { ok: false, code: "check_learning_configuration", message: service.message, hint: service.hint } };

  const completed = await dispatchCheckLearningOperation(service, operation, signal);

  return { exitCode: completed.disposition === "status" ? EXIT_CODES.OK : signal.aborted ? EXIT_CODES.CANCELLED
    : completed.disposition === "succeeded" ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE, result: completed.result };
}

export async function handleCheckLearning(ctx: CliContext, options: CheckLearnOptions): Promise<ExitCode> {
  const cancellation = observeRunCancellation(ctx);
  try {
    const result = await runCheckLearningOperation(ctx, options, cancellation.signal);
    ctx.stdout(`${JSON.stringify(result.result)}\n`);
    return result.exitCode;
  } finally { cancellation.close(); }
}

