import { purgeUnsettledToolCalls } from "../../adapters/session-store/transcript-purge.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { TurnOutcome } from "./host.js";
import type { RunScaffold } from "./run-command.js";
import type { RunFailure } from "./run-failure.js";
import { recover } from "../../adapters/session-store/recovery.js";
import { sessionEffectContinuation } from "./session-effect-continuation.js";

/**
 * The shared next-turn handoff for both interactive surfaces. Raw records carry
 * the durable ordinal high-water even without a compact window; only the read
 * projection drops unanswered requests, never the persisted facts themselves.
 */
export async function scaffoldAfterTurn(scaffold: RunScaffold, outcome: TurnOutcome): Promise<RunScaffold | RunFailure> {
  const read = await scaffold.session?.readRecords();
  if (read !== undefined && !read.ok) {
    await scaffold.close();
    return {
      exitCode: EXIT_CODES.CONFIG,
      message: `session ${scaffold.sessionId} records cannot be read: ${read.code}`,
      hint: "this session is closed; inspect the journal before reopening",
      continuation: "session_closed",
    };
  }

  const recovered = read === undefined ? undefined : recover(read.view.records, read.view.tornTail);
  if (recovered !== undefined && !recovered.ok) {
    await scaffold.close();
    return { exitCode: EXIT_CODES.CONFIG, message: `session history cannot be recovered: ${recovered.code}`,
      hint: "inspect the journal before reopening", continuation: "session_closed" };
  }
  const notice = recovered?.ok && read !== undefined ? sessionEffectContinuation(recovered.session.pendingEffects, read.view.records) : undefined;
  const { effectContinuation: _previousNotice, ...base } = scaffold;

  return {
    ...base,
    ...(notice === undefined ? {} : { effectContinuation: notice }),
    resumeTranscript: purgeUnsettledToolCalls(outcome.transcript),
    ...(read === undefined ? {} : { resumeRecords: read.view.records }),
    ...(outcome.view === undefined || read === undefined ? {} : { resumeView: outcome.view }),
  };
}
