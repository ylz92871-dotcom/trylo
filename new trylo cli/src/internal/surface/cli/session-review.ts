/**
 * Per-turn session review (WP11.3, C38/C75/L37).
 *
 * Reads the durable journal the way an auditor would: transcript items for
 * what was said, `envelope` records for what happened (tool calls,
 * `file_write` facts, checkpoint observations, unknown effects), grouped by
 * turn. The output is a view, never a mutation — the journal is append-only,
 * so "rolling back" here means one of two explicit acts the caller chooses
 * afterwards: `session fork --before-user-message n` for the conversation
 * rail, a scoped checkpoint restore for the file rail. The two rails stay
 * separate by construction (see `ports/checkpoint.ts`).
 *
 * Pure: records in, review out. Checkpoint manifests, the git diff, and the
 * rollback-horizon check are the caller's job; the horizon check reuses the
 * compaction service rather than reimplementing it.
 */

import { createCompactionService } from "../../compaction/service.js";
import type { SessionRecord } from "../../ports/session.js";
import { isTranscriptItem } from "../../protocol/transcript.js";
import { locateUserMessage, type LocatedUserMessage } from "./session-locate.js";

const MAX_TEXT_PREVIEW = 500;
const MAX_TURNS = 200;
const MAX_FILES_PER_TURN = 200;

export type ReviewedToolCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly outcome: string;
  readonly outputPreview: string;
};

export type ReviewedFileWrite = {
  readonly path: string;
  readonly mode: string;
  readonly bytes: number;
};

export type TurnReview = {
  readonly turnId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly userTexts: ReadonlyArray<string>;
  readonly assistantTexts: number;
  readonly toolCalls: ReadonlyArray<ReviewedToolCall>;
  readonly fileWrites: ReadonlyArray<ReviewedFileWrite>;
  readonly checkpointIds: ReadonlyArray<string>;
  /** Effect keys and terminal reasons this turn left unproven. */
  readonly problems: ReadonlyArray<string>;
};

export type SessionReview = {
  readonly turns: ReadonlyArray<TurnReview>;
  readonly prologueSequences: ReadonlyArray<number>;
  readonly truncatedTurns: number;
};

function preview(text: string): string {
  const flat = text.replaceAll("\r\n", "\n");
  if (flat.length <= MAX_TEXT_PREVIEW) {
    return flat;
  }
  return `${flat.slice(0, MAX_TEXT_PREVIEW)}\n... [preview truncated] ...`;
}

type NestedEnvelope = {
  readonly kind: string;
  readonly turnId?: string;
  readonly payload: Record<string, unknown>;
};

function nestedEnvelope(record: SessionRecord): NestedEnvelope | undefined {
  if (record.type !== "envelope") {
    return undefined;
  }

  const nested = (record.payload as Record<string, unknown>)["envelope"];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return undefined;
  }

  const envelope = nested as Record<string, unknown>;
  if (typeof envelope["kind"] !== "string") {
    return undefined;
  }

  const payload = envelope["payload"];

  return {
    kind: envelope["kind"] as string,
    ...(typeof envelope["turnId"] === "string" ? { turnId: envelope["turnId"] as string } : {}),
    payload: typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {},
  };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkpointIdOf(envelope: NestedEnvelope): string | undefined {
  if (envelope.kind !== "observation") {
    return undefined;
  }

  if (envelope.payload["component"] !== "checkpoint" || envelope.payload["status"] !== "ok") {
    return undefined;
  }

  return textOf(envelope.payload["checkpointId"]);
}

function fileWriteOf(envelope: NestedEnvelope): ReviewedFileWrite | undefined {
  if (envelope.kind !== "file_write") {
    return undefined;
  }

  const path = textOf(envelope.payload["path"]);
  const mode = textOf(envelope.payload["mode"]);
  const bytes = envelope.payload["bytes"];
  if (path === undefined || mode === undefined || typeof bytes !== "number") {
    return undefined;
  }

  return { path, mode, bytes };
}

type MutableTurn = {
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  userTexts: string[];
  assistantTexts: number;
  toolCalls: Map<string, ReviewedToolCall>;
  fileWrites: ReviewedFileWrite[];
  checkpointIds: string[];
  problems: string[];
};

/**
 * Groups one journal into per-turn reviews. Records without a turn (session
 * start, compaction windows) are counted as prologue, not forced into a
 * turn they do not belong to.
 */
export function reviewSession(records: ReadonlyArray<SessionRecord>): SessionReview {
  const turns = new Map<string, MutableTurn>();
  const prologueSequences: number[] = [];

  function turnOf(turnId: string | undefined, sequence: number): MutableTurn | undefined {
    if (turnId === undefined) {
      prologueSequences.push(sequence);
      return undefined;
    }

    let turn = turns.get(turnId);
    if (turn === undefined) {
      turn = {
        turnId,
        firstSequence: sequence,
        lastSequence: sequence,
        userTexts: [],
        assistantTexts: 0,
        toolCalls: new Map(),
        fileWrites: [],
        checkpointIds: [],
        problems: [],
      };
      turns.set(turnId, turn);
    }

    if (sequence < turn.firstSequence) {
      turn.firstSequence = sequence;
    }

    if (sequence > turn.lastSequence) {
      turn.lastSequence = sequence;
    }

    return turn;
  }

  for (const record of records) {
    if (record.type === "transcript_item") {
      if (!isTranscriptItem(record.payload)) {
        continue;
      }

      const turn = turnOf(record.turnId, record.sequence);
      if (turn === undefined) {
        continue;
      }

      const item = record.payload;
      if (item.kind === "user") {
        turn.userTexts.push(preview(item.text));
      } else if (item.kind === "assistant_text") {
        turn.assistantTexts += 1;
      } else if (item.kind === "tool_call") {
        if (!turn.toolCalls.has(item.toolCallId)) {
          turn.toolCalls.set(item.toolCallId, {
            toolCallId: item.toolCallId,
            name: item.name,
            outcome: "requested",
            outputPreview: "",
          });
        }
      } else if (item.kind === "tool_result") {
        const seen = turn.toolCalls.get(item.toolCallId);

        turn.toolCalls.set(item.toolCallId, {
          toolCallId: item.toolCallId,
          name: item.name,
          outcome: item.outcome,
          outputPreview: preview(item.output),
        });

        if ((seen === undefined || seen.outcome === "requested") && item.outcome !== "succeeded") {
          turn.problems.push(`tool ${item.name} (${item.toolCallId}) ended ${item.outcome}`);
        }
      }

      continue;
    }

    if (record.type === "effect_unknown") {
      const key = (record.payload as Record<string, unknown>)["key"];
      const turn = turnOf(record.turnId, record.sequence);
      if (turn !== undefined) {
        turn.problems.push(`effect outcome unknown: ${typeof key === "string" ? key : record.sequence}`);
      }
      continue;
    }

    if (record.type === "terminal") {
      const reason = (record.payload as Record<string, unknown>)["reason"];
      if (typeof reason === "string" && reason !== "completed") {
        const turn = turnOf(record.turnId, record.sequence);
        turn?.problems.push(`turn ended ${reason}`);
      }
      continue;
    }

    const envelope = nestedEnvelope(record);
    if (envelope === undefined) {
      // Bookkeeping no turn branch consumes (session start, compact windows,
      // partials): without a turn it is prologue, and a turnful record that
      // reaches here is simply not review content.
      if (record.turnId === undefined) {
        prologueSequences.push(record.sequence);
      }
      continue;
    }

    const turn = turnOf(envelope.turnId ?? record.turnId, record.sequence);
    if (turn === undefined) {
      continue;
    }

    const written = fileWriteOf(envelope);
    if (written !== undefined && turn.fileWrites.length < MAX_FILES_PER_TURN) {
      turn.fileWrites.push(written);
      continue;
    }

    const checkpoint = checkpointIdOf(envelope);
    if (checkpoint !== undefined && !turn.checkpointIds.includes(checkpoint)) {
      turn.checkpointIds.push(checkpoint);
    }
  }

  const ordered = [...turns.values()].sort((left, right) => left.firstSequence - right.firstSequence);
  // Keep the newest turns: review shows the latest turn by default, and a cap
  // that silently kept the oldest would present turn 200 as "latest" (F7).
  const kept = ordered.slice(-MAX_TURNS);

  return {
    turns: kept.map((turn) => ({
      turnId: turn.turnId,
      firstSequence: turn.firstSequence,
      lastSequence: turn.lastSequence,
      userTexts: turn.userTexts,
      assistantTexts: turn.assistantTexts,
      toolCalls: [...turn.toolCalls.values()],
      fileWrites: turn.fileWrites,
      checkpointIds: turn.checkpointIds,
      problems: turn.problems,
    })),
    prologueSequences,
    truncatedTurns: ordered.length - kept.length,
  };
}

export type RollbackPreview =
  | {
    readonly ok: true;
    readonly horizonSequence: number;
    readonly visibleItems: number;
    readonly hiddenItems: number;
    /** The journal is never rewritten by a preview; rollback executes via fork. */
    readonly journalUntouched: true;
  }
  | { readonly ok: false; readonly code: "nothing_to_roll_back" | "sequence_unknown"; readonly detail: string };

/**
 * Validates a rollback horizon and reports what the model would see under
 * it. View-only: executing the rollback is `session fork
 * --before-user-message n`, which the caller names from `locateTurn`.
 */
export function previewRollback(
  records: ReadonlyArray<SessionRecord>,
  sequence: number,
): RollbackPreview {
  const service = createCompactionService();
  const horizon = service.rollbackTranscript({ records, sequence });
  if (!horizon.ok) {
    return horizon;
  }

  const projected = service.projectForPrompt({ records, horizonSequence: horizon.horizonSequence });
  if (!projected.ok) {
    return { ok: false, code: "sequence_unknown", detail: projected.detail };
  }

  let total = 0;

  for (const record of records) {
    if (record.type === "transcript_item" && isTranscriptItem(record.payload)) {
      total += 1;
    }
  }

  return {
    ok: true,
    horizonSequence: horizon.horizonSequence,
    visibleItems: projected.view.items.length,
    hiddenItems: total - projected.view.items.length,
    journalUntouched: true,
  };
}

export type LocatedTurn = LocatedUserMessage;

/**
 * Finds the turn that holds the nth user message. Delegates to the shared
 * locator so the numbering, refusal codes and fail-closed behaviour stay
 * identical to `session fork --before-user-message`.
 */
export function locateTurnByUserMessage(
  records: ReadonlyArray<SessionRecord>,
  n: number,
): LocatedTurn {
  return locateUserMessage(records, n);
}
