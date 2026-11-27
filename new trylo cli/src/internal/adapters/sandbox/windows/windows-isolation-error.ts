export class IsolationCleanupError extends AggregateError {}

/** Keep both failures visible when compensating a partially prepared boundary.
 * The aggregate's message crosses the tool boundary; its errors preserve the
 * original exceptions for diagnostics without treating compensation as success.
 */
export function isolationCleanupError(
  phase: "partial grant" | "bootstrap lease",
  cause: unknown,
  cleanup: unknown,
): AggregateError {
  return new IsolationCleanupError([cause, cleanup],
    `isolation_cleanup_failed: ${phase} could not be revoked; cause: ${message(cause)}; cleanup: ${message(cleanup)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
