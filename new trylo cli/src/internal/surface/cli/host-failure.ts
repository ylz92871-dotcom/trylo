import { ExecutionProgressError } from "../../ports/execution-progress.js";
import type { SessionPort } from "../../ports/session.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { BootstrapContextError, bootstrapContextFailure } from "./bootstrap-context.js";
import type { RunFailure } from "./run-failure.js";

/** Close the failed lease and translate only failures owned by the public host. */
export async function hostFailure(error: unknown, session: SessionPort | undefined): Promise<RunFailure> {
  if (!(error instanceof BootstrapContextError) && !(error instanceof ExecutionProgressError)) throw error;

  // A caller retaining the port must not reuse a failed durability/source lease.
  await session?.release();

  if (error instanceof BootstrapContextError) {
    return { ...bootstrapContextFailure(error), ...(session === undefined ? {} : { continuation: "session_closed" as const }) };
  }

  return {
    exitCode: EXIT_CODES.CONFIG,
    message: `${error.code === "effect_reconciliation_required"
      ? "An operation's final result is unconfirmed. Further actions stopped to avoid repeating it."
      : "This turn stopped because its progress could not be saved. Further actions stopped."} (${error.message})`,
    hint: "this session is closed; inspect its journal and workspace before reopening because an action outcome may need reconciliation",
    continuation: "session_closed",
  };
}
