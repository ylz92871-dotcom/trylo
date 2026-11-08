import type { Hash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { reduce } from "../../learning/control/reducer.js";
import { recoverMethodCommandIdentities } from "../../learning/control/method-replay.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { StoreLoadErr } from "../../learning/control/store-port.js";
import { decodeLog, decodeLogSuffix, type ParsedLog } from "./codec.js";
import { boardReplayMemo } from "./replay-memo.js";
import { BOARD_SNAPSHOT_FILE, decodeBoardSnapshot, type BoardSnapshotFile } from "./board-snapshot.js";
import { decodeReplayCheckpoint, logBytesHash, REPLAY_CHECKPOINT_FILE, type ReplayWatermark, type SnapshotBinding } from "./replay-checkpoint.js";

export const BOARD_LOG_FILE = "board-events.ndjson";

export interface BoardReplayReport {
  readonly mode: "cold" | "memo_exact" | "memo_suffix" | "checkpoint";
  readonly decodedRecords: number;
  readonly reducedRecords: number;
  readonly prefixBytes: number;
  readonly suffixBytes: number;
  readonly physicalSequence: number;
}

interface BoardLogMetadata {
  readonly byteLength: number;
  readonly physicalSequence: number;
  readonly tornTail: boolean;
  readonly baseSnapshot: SnapshotBinding;
  readonly checkpointAllowed: boolean;
  readonly checkpoint?: ReplayWatermark;
}

/** Only a private apply call retains its actual read bytes until that append
 * returns. Public readers retain no Buffer or deferred hashing closure. */
export type VerifiedBoardLog = BoardLogMetadata & ({ readonly kind: "read" }
  | { readonly kind: "append"; readonly bytes: Buffer; readonly digestPrefix?: { readonly digest: Hash; readonly byteLength: number } });

export type VerifiedBoardRead = StoreLoadErr | { readonly ok: true; readonly state: BoardState; readonly generation: number;
  readonly log: VerifiedBoardLog; readonly report: BoardReplayReport };

type SnapshotRead = { readonly kind: "absent" | "invalid" }
  | { readonly kind: "valid"; readonly file: BoardSnapshotFile; readonly sha256: string };

type SnapshotMemo = { readonly raw: Buffer; readonly file: BoardSnapshotFile; readonly sha256: string };

const snapshotMemos = new Map<string, SnapshotMemo>();
const MAX_SNAPSHOT_MEMO_BYTES = 128 * 1024 * 1024;
let snapshotMemoBytes = 0;

function forgetSnapshot(root: string): void {
  const prior = snapshotMemos.get(root);
  if (prior !== undefined) {
    snapshotMemoBytes -= prior.raw.length;
    snapshotMemos.delete(root);
  }
}

export async function readBoardLog(root: string): Promise<Buffer> {
  try { return await readFile(path.join(root, BOARD_LOG_FILE)); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

function readSnapshot(root: string): SnapshotRead {
  const file = path.join(root, BOARD_SNAPSHOT_FILE);
  const key = path.resolve(root);

  if (!existsSync(file)) {
    forgetSnapshot(key);
    return { kind: "absent" };
  }

  try {
    const raw = readFileSync(file), prior = snapshotMemos.get(key);

    // Reuse only the exact bytes which already passed the original decoder and
    // checksum. Metadata alone never establishes an unchanged snapshot.
    if (prior !== undefined && raw.equals(prior.raw)) {
      snapshotMemos.delete(key);
      snapshotMemos.set(key, prior);
      return { kind: "valid", file: prior.file, sha256: prior.sha256 };
    }

    forgetSnapshot(key);
    const snapshot = decodeBoardSnapshot(raw.toString("utf8"));
    if (snapshot === undefined) return { kind: "invalid" };

    const sha256 = logBytesHash(raw);

    if (raw.length <= MAX_SNAPSHOT_MEMO_BYTES) {
      while (snapshotMemos.size >= 2 || snapshotMemoBytes + raw.length > MAX_SNAPSHOT_MEMO_BYTES) {
        const oldest = snapshotMemos.keys().next().value;
        if (oldest === undefined) break;
        forgetSnapshot(oldest);
      }
      snapshotMemos.set(key, { raw, file: snapshot, sha256 });
      snapshotMemoBytes += raw.length;
    }

    return { kind: "valid", file: snapshot, sha256 };
  } catch {
    forgetSnapshot(key);
    return { kind: "invalid" };
  } // Original cold recovery remains authoritative.
}

export function replayCheckpointStamp(root: string): string {
  try {
    const stat = statSync(path.join(root, REPLAY_CHECKPOINT_FILE), { throwIfNoEntry: false });
    return stat === undefined ? "absent" : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return "unavailable"; } // Optional cache metadata cannot deny an otherwise readable Board.
}

async function checkpointText(root: string): Promise<string | undefined> {
  try { return await readFile(path.join(root, REPLAY_CHECKPOINT_FILE), "utf8"); }
  catch { return undefined; } // This disposable sidecar is never required for authoritative recovery.
}

/** All authority reads happen once here. Callers may reuse the verified physical
 * tail under their existing writer lock without decoding the log a second time. */
export async function readVerifiedBoard(root: string, priorGeneration: number, purpose: "read" | "append" = "read"): Promise<VerifiedBoardRead> {
  const snapshot = readSnapshot(root), raw = await readBoardLog(root), stamp = replayCheckpointStamp(root);
  const baseSnapshot: SnapshotBinding = snapshot.kind === "valid" ? { sha256: snapshot.sha256, generation: snapshot.file.generation } : null;
  const generation = snapshot.kind === "valid" ? snapshot.file.generation : priorGeneration;
  const memoEligible = snapshot.kind !== "invalid";
  let memoPublish = memoEligible && stamp === "absent";
  const evidence = (digestPrefix?: { readonly digest: Hash; readonly byteLength: number }) => purpose === "append"
    ? { kind: "append" as const, bytes: raw, ...(digestPrefix === undefined ? {} : { digestPrefix }) } : { kind: "read" as const };
  const finish = (state: BoardState, parsed: ParsedLog, mode: BoardReplayReport["mode"], prefixBytes = 0,
    checkpoint?: ReplayWatermark, digestPrefix?: { readonly digest: Hash; readonly byteLength: number }): VerifiedBoardRead => {
    const physicalSequence = parsed.records.at(-1)?.sequence ?? checkpoint?.physicalSequence ?? 0;
    if (memoPublish && !parsed.discardedTornTail && physicalSequence > 0) {
      boardReplayMemo.remember(root, raw, state, physicalSequence, { checkpointStamp: stamp,
        baseSnapshot,
        ...(checkpoint === undefined ? {} : { checkpoint }) });
    }

    return { ok: true, state, generation, log: { byteLength: raw.length, physicalSequence,
      tornTail: parsed.discardedTornTail, baseSnapshot, ...evidence(digestPrefix),
      checkpointAllowed: snapshot.kind !== "invalid", ...(checkpoint === undefined ? {} : { checkpoint }) },
    report: { mode, decodedRecords: parsed.records.length, reducedRecords: parsed.records.length,
      prefixBytes, suffixBytes: raw.length - prefixBytes, physicalSequence } };
  };

  if (memoEligible) {
    boardReplayMemo.observeCheckpoint(root, stamp);
    const hit = boardReplayMemo.read(root, raw, baseSnapshot);
    if (hit !== undefined) return { ok: true, state: hit.state, generation,
      log: { byteLength: raw.length, physicalSequence: hit.physicalSequence, tornTail: false,
        baseSnapshot, checkpointAllowed: true, ...evidence(),
        ...(hit.checkpoint === undefined ? {} : { checkpoint: hit.checkpoint }) },
      report: { mode: hit.mode === "exact" ? "memo_exact" : "memo_suffix", decodedRecords: hit.replayedRecords,
        reducedRecords: hit.replayedRecords, prefixBytes: hit.prefixBytes,
        suffixBytes: raw.length - hit.prefixBytes, physicalSequence: hit.physicalSequence } };
  } else boardReplayMemo.forget(root);

  const serialized = snapshot.kind === "invalid" ? undefined : await checkpointText(root);
  const checkpoint = serialized === undefined ? undefined : decodeReplayCheckpoint(serialized, raw, baseSnapshot);
  if (checkpoint !== undefined) {
    const suffix = decodeLogSuffix(raw.subarray(checkpoint.prefix.byteLength).toString("utf8"), checkpoint.prefix.physicalSequence + 1);
    if (suffix.ok && !suffix.discardedTornTail) {
      let state = checkpoint.state;

      // Unlike the cold path, suffixes cannot restore an unproved old command ID.
      for (const record of suffix.records) {
        const reduced = reduce(state, record.command);
        if (!reduced.ok) return { ok: false, reason: reduced.reason, detail: reduced.detail };
        state = reduced.state;
      }

      memoPublish = memoEligible;

      return finish(state, suffix, "checkpoint", checkpoint.prefix.byteLength, checkpoint.prefix,
        { digest: checkpoint.digest, byteLength: checkpoint.prefix.byteLength });
    }
  }

  const parsed = decodeLog(raw.toString("utf8"));
  if (!parsed.ok) return parsed;

  const completeReplay = parsed.records[0]?.events[0]?.sequence === 1;
  if (snapshot.kind !== "valid" && !completeReplay && (snapshot.kind !== "absent" || parsed.records.length > 0)) {
    return { ok: false, reason: "snapshot_corrupt", detail: "checkpoint is unavailable and the retained log cannot rebuild the complete Board" };
  }

  // The exact-byte snapshot memo is private. A cold reducer receives its own
  // copy so no returned state can mutate the independently verified base.
  let state = snapshot.kind === "valid" ? structuredClone(snapshot.file.state) : emptyBoardState();

  state = recoverMethodCommandIdentities(state, parsed.records.map(record => record.command));

  for (const record of parsed.records) {
    const reduced = reduce(state, record.command);
    if (!reduced.ok) return { ok: false, reason: reduced.reason, detail: reduced.detail };
    state = reduced.state;
  }

  // A compacted log without its old snapshot can never seed an independent memo.
  return finish(state, parsed, "cold");
}
