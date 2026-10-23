/** Shared by the advertised schema, executor and recovery feedback. */
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1;

/** Recovery advice must stay within the same timeout contract as execution. */
export function timeoutRecoveryHelp(timeoutMs: number): string {
  const inspection = "The timed-out command was terminated and may have partial effects; no rollback occurred. Inspect the partial output, files and the command for stalled work before retrying. For long work, start one runInBackground command and poll its existing sessionId with write_stdin instead of repeating it.";
  if (timeoutMs >= MAX_TIMEOUT_MS) {
    return `${inspection} The ${MAX_TIMEOUT_MS}ms foreground limit is already exhausted; a larger timeoutMs is not allowed. Fix the stalled work or split the command into bounded steps instead of rerunning it unchanged.`;
  }
  return `${inspection} If the command is making progress and needs more time, pass a larger timeoutMs (up to ${MAX_TIMEOUT_MS}).`;
}
