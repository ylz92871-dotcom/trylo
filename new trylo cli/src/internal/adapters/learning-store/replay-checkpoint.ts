import { createHash, type Hash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { fields, sequence } from "../../validation/json-shape.js";
import { decodeLogSuffix } from "./codec.js";
import { snapshotState } from "./board-snapshot.js";

export const REPLAY_CHECKPOINT_FILE = "board-replay-checkpoint.json";
/** Bump when reducer meaning or normalized state interpretation changes.
 * Container schema alone cannot make an older replay projection reusable. */
export const BOARD_REPLAY_VERSION = "trylo-board-replay-2026-11-05-v1";

export interface ReplayWatermark { readonly byteLength: number; readonly physicalSequence: number }

export interface ReplayPrefix extends ReplayWatermark { readonly sha256: string; readonly logicalSequence: number }

export type SnapshotBinding = { readonly sha256: string; readonly generation: number } | null;

export interface ReplayCheckpoint {
  readonly schemaVersion: 1;
  readonly replayVersion: typeof BOARD_REPLAY_VERSION;
  readonly baseSnapshot: SnapshotBinding;
  readonly prefix: ReplayPrefix;
  readonly state: BoardState;
  readonly checksum: string;
}

export interface ReplayCheckpointPolicy { readonly minimumBytes: number; readonly minimumRecords: number }

export interface VerifiedReplayCheckpoint extends ReplayCheckpoint { readonly digest: Hash }

export const DEFAULT_REPLAY_CHECKPOINT_POLICY: ReplayCheckpointPolicy = Object.freeze({ minimumBytes: 1024 * 1024, minimumRecords: 64 });
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const logBytesHash = (raw: Buffer): string => createHash("sha256").update(raw).digest("hex");
const checksum = ({ checksum: _checksum, ...body }: ReplayCheckpoint) => sha256Hex(canonicalJson(body));

export function encodeReplayCheckpoint(state: BoardState, prefix: ReplayPrefix, baseSnapshot: SnapshotBinding): string {
  const body: ReplayCheckpoint = { schemaVersion: 1, replayVersion: BOARD_REPLAY_VERSION, baseSnapshot, prefix, state, checksum: "" };
  return `${JSON.stringify({ ...body, checksum: checksum(body) })}\n`;
}

export function decodeReplayCheckpoint(text: string, raw: Buffer, baseSnapshot: SnapshotBinding): VerifiedReplayCheckpoint | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!fields(value, ["schemaVersion", "replayVersion", "baseSnapshot", "prefix", "state", "checksum"])
      || value.schemaVersion !== 1 || value.replayVersion !== BOARD_REPLAY_VERSION || !hash(value.checksum)
      || !fields(value.prefix, ["byteLength", "sha256", "physicalSequence", "logicalSequence"])
      || !sequence(value.prefix.byteLength) || value.prefix.byteLength < 1 || value.prefix.byteLength > raw.length
      || !sequence(value.prefix.physicalSequence) || value.prefix.physicalSequence < 1 || !sequence(value.prefix.logicalSequence)
      || !hash(value.prefix.sha256) || raw[value.prefix.byteLength - 1] !== 10 || raw[raw.length - 1] !== 10
      || canonicalJson(value.baseSnapshot) !== canonicalJson(baseSnapshot) || !snapshotState(value.state)
      || value.state.sequence !== value.prefix.logicalSequence) return undefined;

    const checkpoint: ReplayCheckpoint = { schemaVersion: 1, replayVersion: BOARD_REPLAY_VERSION, baseSnapshot,
      prefix: { byteLength: value.prefix.byteLength, sha256: value.prefix.sha256, physicalSequence: value.prefix.physicalSequence,
        logicalSequence: value.prefix.logicalSequence }, state: value.state, checksum: value.checksum };
    const digest = createHash("sha256").update(raw.subarray(0, checkpoint.prefix.byteLength));
    if (checksum(checkpoint) !== checkpoint.checksum || digest.copy().digest("hex") !== checkpoint.prefix.sha256) return undefined;

    // One original boundary record verifies the physical cursor. It is never
    // reduced again; all replayed commands come strictly after the prefix.
    let end = checkpoint.prefix.byteLength;

    while (end > 0 && raw[end - 1] === 10) end--;

    const start = raw.lastIndexOf(10, end - 1) + 1;
    const tail = decodeLogSuffix(`${raw.subarray(start, end).toString("utf8")}\n`, checkpoint.prefix.physicalSequence);
    if (!tail.ok || tail.records.length !== 1 || tail.discardedTornTail) return undefined;

    const lastLogical = tail.records[0]!.events.at(-1)?.sequence;
    if (lastLogical !== undefined && lastLogical !== checkpoint.prefix.logicalSequence) return undefined;

    return { ...checkpoint, digest };
  } catch {
    // A cache is never authority for malformed state, version or proof bytes.
    return undefined;
  }
}

export function checkpointDue(current: ReplayWatermark, previous: ReplayWatermark | undefined,
  policy: ReplayCheckpointPolicy): boolean {
  return current.byteLength - (previous?.byteLength ?? 0) >= policy.minimumBytes
    || current.physicalSequence - (previous?.physicalSequence ?? 0) >= policy.minimumRecords;
}
