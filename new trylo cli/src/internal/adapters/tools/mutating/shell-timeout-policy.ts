/** Explicit deadlines must be positive integral milliseconds. Omission is unlimited. */
export const MIN_TIMEOUT_MS = 1;

/** Recovery advice must stay within the same timeout contract as execution. */
export function timeoutRecoveryHelp(): string {
  const inspection = "The timed-out command was terminated and may have partial effects; no rollback occurred. Inspect the partial output, files and the command for stalled work before retrying. For long work, start one runInBackground command and poll its existing sessionId with write_stdin instead of repeating it.";
  return `${inspection} If the command was making progress, omit timeoutMs or choose a longer explicit deadline on a deliberate retry.`;
}

export { executionDeadline as shellDeadline } from "../../execution-deadline.js";
