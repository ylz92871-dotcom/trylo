import type { CompactWindow, CompactRecordDraft } from "../../ports/compaction.js";
import type { CompactionWiring } from "../../loop/compact-boundary.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import { compactionWiring } from "./compaction-wiring.js";
import { listTranscript } from "../../compaction/projection.js";

/**
 * Compacting a session on demand (`/compact`).
 *
 * The run already compacts itself when the prompt grows past the budget; this
 * is the manual trigger for a person who can see it coming — a long session
 * they want to keep going without waiting for the ceiling.
 *
 * The window is **written to the journal**, not merely held in memory. That
 * costs a little and buys the only thing that matters here: the compaction
 * survives leaving the REPL. A window carried only on the scaffold would look
 * like it worked and then be gone on the next `/resume`, which is worse than
 * refusing.
 *
 * Shared by both REPLs so `/compact` means one thing wherever it is typed.
 */

export type CompactResult =
  | { readonly ok: true; readonly window: CompactWindow; readonly wrote: boolean }
  | { readonly ok: false; readonly problem: string };

export async function compactSession(
  ctx: Pick<CliContext, "now">,
  sessionId: string,
  records: ReadonlyArray<SessionRecord>,
  session: Pick<SessionPort, "append"> | undefined,
  options?: { readonly wiring?: CompactionWiring; readonly signal?: AbortSignal; readonly accept?: (draft: CompactRecordDraft) => boolean },
): Promise<CompactResult> {
  if (options?.signal?.aborted) return { ok: false, problem: "cancelled" };
  if (records.length === 0) {
    return { ok: false, problem: "nothing to compact yet" };
  }
  const wiring = options?.wiring ?? compactionWiring({ nowMs: ctx.now() });
  const projected = wiring.port.projectForPrompt({ records });
  if (!projected.ok) {
    return { ok: false, problem: `${projected.code}: ${projected.detail}` };
  }
  const at = new Date(ctx.now()).toISOString();
  const summary = await wiring.summarize(projected.view.items, projected.view.window?.summary, options?.signal, listTranscript(records));
  const compacted = wiring.port.compact({ records, sessionId, at, summary });
  if (!compacted.ok) {
    // `nothing_to_compact` is the ordinary answer for a session whose history
    // is already one window — not a failure worth alarming anyone over, but
    // still an answer, because a command that silently did nothing is how a
    // person stops trusting the command.
    return { ok: false, problem: `${compacted.code}: ${compacted.detail}` };
  }
  const window = compacted.record.payload;
  if (options?.signal?.aborted) return { ok: false, problem: "cancelled" };
  if (options?.accept && !options.accept(compacted.record)) return { ok: false, problem: "nothing_to_reduce" };
  if (session === undefined) {
    // The scaffold has no journal (a session opened without one). The window is
    // still returned, and the caller says it is for this process only.
    return { ok: true, window, wrote: false };
  }
  const appended = await session.append(compacted.record);
  if (!appended.ok) {
    return { ok: false, problem: `could not write the compaction: ${appended.code}` };
  }
  return { ok: true, window, wrote: true };
}

/** One line for the screen, naming what the window now stands in for. */
export function compactNote(window: CompactWindow, wrote: boolean): string {
  const span =
    window.replacedFromSequence === window.replacedToSequence
      ? `${window.replacedFromSequence}`
      : `${window.replacedFromSequence}-${window.replacedToSequence}`;
  const where = wrote ? "" : " (this process only: no journal to write to)";
  return `compacted ${span} into ${window.windowId}${where}`;
}
