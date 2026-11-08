import type { LocalRuleSource } from "../../adapters/project-instructions/appendix.js";
import { windowOnJournal } from "../../loop/compact-boundary.js";
import type { RunTurnResult } from "../../loop/runner.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { SessionPort } from "../../ports/session.js";
import type { CliRunStatus, CliUsage, CliUsageAccounting } from "../../protocol/cli-stream.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { Transcript, TranscriptItem } from "../../protocol/transcript.js";
import { sessionPayload } from "./session-payload.js";
import type { TurnRecorder } from "./turn-recorder.js";
import { ExecutionProgressError } from "../../ports/execution-progress.js";
import { accountingToCli } from "./host-status.js";
import type { PromptInputCheckpoint } from "../../ports/prompt-input.js";
import { promptInputCheckpointForCompletion } from "../../loop/prompt-input-records.js";

/**
 * Turn result -> durable session records.
 *
 * Only facts the run actually produced are written; nothing is inferred and
 * nothing is back-filled from a UI projection. A write failure is returned as a
 * warning on the legacy bulk API. Live recording awaits each fact and fails
 * closed through ExecutionProgressError, including compact tail records.
 */

export type PersistTurnInput = {
  readonly toolCatalogHash?: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Items added by this turn only; resumed items are already on disk. */
  readonly newTranscript: Transcript;
  readonly envelopes: ReadonlyArray<Envelope>;
  readonly promptInputCheckpoint?: PromptInputCheckpoint;
  readonly issuedKeys: ReadonlyArray<string>;
  readonly committedKeys: ReadonlyArray<string>;
  readonly terminalReason: string;
  readonly finishReason: string;
  readonly iterations: number;
  readonly usage: CliUsage;
  readonly accounting?: CliUsageAccounting;
  /** The turn's own bounds: the journal brackets what happened between them. */
  readonly startedAt: string;
  readonly finishedAt: string;
  /**
   * Stamps non-envelope records one append at a time. Envelope records carry
   * their own emission time instead — stamping everything with one flush
   * moment made the whole timeline unreadable (hard-eval D7-②).
   */
  readonly clock: () => string;
  /**
   * The project rules this turn was given, as sources only.
   *
   * Provenance, not content: which file, which scope, which content hash. The
   * rule text itself is not re-persisted per turn — a resume re-reads the
   * current file and compares hashes, so what the run *used* stays checkable
   * without turning every journal into a copy of the repository's instructions
   * (WP-CLI-B1 §3.2). Absent — a project with no rule file, and every caller
   * predating this field — leaves the payload exactly as it was.
   */
  readonly projectInstructionSources?: ReadonlyArray<ProjectInstructionSource>;
};

/** The recorded form of one adopted rule. Mirrors the host's source fact. */
export type ProjectInstructionSource = LocalRuleSource;

/** Round-trips through JSON so the persisted payload is provably JSON, not a cast. */
function itemPayload(item: TranscriptItem): JsonObject {
  return sessionPayload(item);
}

async function appendOne(
  session: SessionPort,
  warnings: string[],
  record: Parameters<SessionPort["append"]>[0],
): Promise<boolean> {
  const result = await session.append(record);
  if (!result.ok) {
    warnings.push(`session_append_failed:${record.type}:${result.code}`);
  }
  return result.ok;
}

export async function persistTurn(
  session: SessionPort,
  input: PersistTurnInput,
): Promise<ReadonlyArray<string>> {
  const warnings: string[] = [];

  await appendOne(session, warnings, {
    type: "turn_start",
    sessionId: input.sessionId,
    turnId: input.turnId,
    at: input.startedAt,
    payload: {
      iterations: input.iterations,
      ...(input.toolCatalogHash === undefined ? {} : { toolCatalogHash: input.toolCatalogHash }),
      // Present only when rules were adopted, so a project without them produces
      // byte-identical records to the ones written before this field existed.
      ...(input.projectInstructionSources === undefined
        ? {}
        : { projectInstructions: sessionPayload(input.projectInstructionSources) }),
    },
  });

  for (const item of input.newTranscript) {
    await appendOne(session, warnings, {
      type: "transcript_item",
      sessionId: input.sessionId,
      turnId: input.turnId,
      at: input.clock(),
      payload: itemPayload(item),
    });
  }

  let streamIndex = 0, streamAttemptId: string | undefined, streamOpen = false;

  for (const envelope of input.envelopes) {
    const measured = input.promptInputCheckpoint === undefined ? undefined
      : promptInputCheckpointForCompletion(input.promptInputCheckpoint, envelope, {
        sessionId: input.sessionId, turnId: input.turnId, attemptId: streamAttemptId, streamIndex, open: streamOpen,
      });
    const acknowledged = await appendOne(session, warnings, {
      type: "envelope",
      sessionId: input.sessionId,
      turnId: input.turnId,
      at: envelope.timestamp,
      payload: { envelope: sessionPayload(envelope),
        ...(measured?.kind === "available" ? { promptInputCheckpoint: sessionPayload(measured.checkpoint) } : {}),
      },
    });
    if (acknowledged && envelope.kind === "api_call" && envelope.sessionId === input.sessionId && envelope.turnId === input.turnId) {
      streamIndex += 1;
      streamAttemptId = envelope.attemptId;
      streamOpen = true;
    }

    if (acknowledged && envelope.kind === "stream_end") streamOpen = false;
  }

  const committed = new Set(input.committedKeys);

  for (const key of input.issuedKeys) {
    await appendOne(session, warnings, {
      type: "effect_issued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      at: input.clock(),
      payload: { key },
    });
    if (committed.has(key)) {
      await appendOne(session, warnings, {
        type: "effect_committed",
        sessionId: input.sessionId,
        turnId: input.turnId,
        at: input.clock(),
        payload: { key },
      });
    }
  }

  await appendOne(session, warnings, {
    type: "terminal",
    sessionId: input.sessionId,
    turnId: input.turnId,
    at: input.finishedAt,
    payload: {
      reason: input.terminalReason,
      finishReason: input.finishReason,
      usage: sessionPayload(input.usage),
      ...(input.accounting === undefined ? {} : { accounting: sessionPayload(input.accounting) }),
    },
  });

  return warnings;
}

/** Transcript items this turn added, given the transcript it resumed from. */
export function newTranscriptItems(transcript: Transcript, resumed: Transcript): Transcript {
  const lastResumed = resumed.length === 0 ? -1 : (resumed[resumed.length - 1]?.sequence ?? -1);
  return transcript.filter((item) => item.sequence > lastResumed);
}

/**
 * What storing a turn needs from its host. Narrow on purpose: the callers
 * hold a much larger host object, and only these five facts decide what is
 * written. `TurnHostInput` satisfies it structurally, so no caller changes.
 */
export type PersistTurnHost = {
  /** When live recording was used, finish only writes terminal and windows. */
  readonly recorder?: TurnRecorder;
  readonly toolCatalogHash?: string;
  readonly session?: SessionPort;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resumeTranscript?: Transcript;
  /** Milliseconds since the epoch; a clock is never read here. */
  readonly now: () => number;
  /**
   * The turn's start, when the host knows it. Absent — every caller but the run
   * host — means turn_start falls back to the flush moment, exactly as before.
   */
  readonly startedAtMs?: number;
  /**
   * The project rules this turn was given, recorded as sources on `turn_start`.
   *
   * Structurally satisfied by `TurnHostInput`, so no caller has to change: a
   * host that has a project context passes it, and one that does not leaves the
   * field absent and the record unchanged.
   */
  readonly projectContext?: { readonly sources: ReadonlyArray<ProjectInstructionSource> };
};

export type Persisted = {
  readonly warnings: ReadonlyArray<string>;
  /** The window the journal holds for this turn, or the loop's own when none was stored. */
  readonly view: CompactWindow | undefined;
};

/**
 * The whole of a settled turn: its records, then the windows it decided.
 *
 * Order matters. The windows are appended after the turn's own records,
 * through the same port every other record uses, because a window can only
 * be placed on a journal that already holds what it replaces.
 */
export async function persistTurnResult(
  host: PersistTurnHost,
  result: RunTurnResult,
  usage: CliUsage,
  status: CliRunStatus,
): Promise<Persisted> {
  const session = host.session;
  if (session === undefined) {
    // No journal to store a window in and none to express one against: a window
    // numbered in a journal that does not exist cannot be carried forward.
    return { warnings: [], view: undefined };
  }

  const resumed = host.resumeTranscript ?? [];
  const finishedAt = new Date(host.now()).toISOString();
  const clock = (): string => new Date(host.now()).toISOString();
  const accounting = accountingToCli(result);
  const details = Object.keys(accounting).length === 0 ? {} : { accounting };
  const warnings = host.recorder === undefined ? await persistTurn(session, {
    ...(host.toolCatalogHash === undefined ? {} : { toolCatalogHash: host.toolCatalogHash }),
    sessionId: host.sessionId,
    turnId: host.turnId,
    newTranscript: newTranscriptItems(result.transcript, resumed),
    envelopes: result.envelopes,
    ...(result.promptInputCheckpoint === undefined ? {} : { promptInputCheckpoint: result.promptInputCheckpoint }),
    issuedKeys: result.issuedKeys,
    committedKeys: result.committedKeys,
    terminalReason: status,
    finishReason: result.state.finishReason,
    iterations: result.iterations,
    usage,
    ...details,
    startedAt:
      host.startedAtMs === undefined ? finishedAt : new Date(host.startedAtMs).toISOString(),
    finishedAt,
    clock,
    ...(host.projectContext === undefined
      ? {}
      : { projectInstructionSources: host.projectContext.sources }),
  }) : [];

  if (host.recorder !== undefined) {
    await host.recorder.finish({ status, finishReason: result.state.finishReason, usage, ...details });
  }

  // A failed append is reported, never swallowed: a turn whose window never
  // reached disk must not read as a complete success.
  const stored = await storeCompactions(session, result, host.recorder === undefined ? "legacy" : "live");

  return {
    warnings: [...warnings, ...stored.warnings],
    // A window this turn decided but could not store is one no journal holds, so
    // it is not carried forward: the loop's own bounds are numbered in nothing
    // on disk, and a later turn would misread them against the real journal.
    view: result.compactions.length === 0 ? result.promptView : stored.view,
  };
}

/**
 * Appends each stored window, in the order the loop stored it.
 *
 * The loop decides in its own numbering — `session_start` at 0 and the transcript
 * items after it — because that is the only numbering it can compare a new window
 * against. Only out here is the journal's own numbering visible, so only out here
 * can a window be placed on it. A window that cannot be placed on the journal it
 * is stored in is worse than no window: the text it claims to have replaced would
 * go back to the model under a summary saying it is gone. It is refused and
 * reported, exactly like a summary the port refused.
 */
async function storeCompactions(
  session: SessionPort,
  result: RunTurnResult,
  mode: "legacy" | "live",
): Promise<Persisted> {
  const drafts = result.compactions;
  const warnings: string[] = [];

  if (drafts.length === 0) {
    return { warnings, view: undefined };
  }

  const read = await session.readRecords();
  if (!read.ok && mode === "live") throw new ExecutionProgressError("compact_read", read.code);

  const records = read.ok ? read.view.records : [];
  let view: CompactWindow | undefined;

  for (const draft of drafts) {
    const payload = windowOnJournal(draft.payload, records, result.compactionSourceRecords);
    if (payload === undefined) {
      if (mode === "live") throw new ExecutionProgressError("compact", "window_not_on_journal");
      warnings.push(`session_append_failed:${draft.type}:window_not_on_journal`);
      continue;
    }

    const appended = await session.append({
      type: draft.type,
      sessionId: draft.sessionId,
      at: draft.at,
      payload,
    });
    if (!appended.ok) {
      if (mode === "live") throw new ExecutionProgressError("compact", appended.code);
      warnings.push(`session_append_failed:${draft.type}:${appended.code}`);
      continue;
    }

    view = payload;
  }

  return { warnings, view };
}
