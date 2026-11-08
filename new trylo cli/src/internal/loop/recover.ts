import type { EffectCommand } from "../domain/command.js";
import type { ReduceInput } from "../domain/input.js";
import { reduce } from "../domain/reduce.js";
import { replay, sameState } from "../domain/replay.js";
import { initialState, type ExecutionState } from "../domain/state.js";
import type { Envelope } from "../protocol/envelope.js";
import { verifyJournal } from "./checksum.js";

export type RecoveryLog = {
  readonly inputs: readonly ReduceInput[];
  readonly envelopes: readonly Envelope[];
  readonly checksums: readonly string[];
  readonly issuedKeys: readonly string[];
  readonly committedKeys: readonly string[];
};

export type RecoveryResult =
  | {
      readonly ok: true;
      readonly state: ExecutionState;
      readonly reissue: readonly EffectCommand[];
    }
  | { readonly ok: false; readonly code: "checksum" };

export function recover(log: RecoveryLog): RecoveryResult {
  const journal = verifyJournal(log.envelopes, log.checksums);
  if (!journal.ok) {
    return { ok: false, code: "checksum" };
  }

  const replayed = replay(log.inputs);
  if (replayed.failedAt !== undefined) {
    return { ok: true, state: replayed.state, reissue: [] };
  }

  const committed = new Set(log.committedKeys);
  const issued = new Set(log.issuedKeys);
  const reissue: EffectCommand[] = [];
  let state = initialState();

  for (const input of log.inputs) {
    const result = reduce(state, input);
    if (!result.ok) {
      break;
    }

    state = result.state;

    for (const command of result.commands) {
      if (committed.has(command.idempotencyKey)) {
        continue;
      }

      // An issued side effect may already have happened even without a commit record.
      if (issued.has(command.idempotencyKey) && command.type !== "emit") {
        continue;
      }

      reissue.push(command);
    }
  }

  return { ok: true, state, reissue };
}

export function journalMatchesReplay(
  inputs: readonly ReduceInput[],
  state: ExecutionState,
): boolean {
  return sameState(replay(inputs).state, state);
}
