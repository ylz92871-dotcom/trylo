import path from "node:path";
import { reduce } from "../../learning/control/reducer.js";
import type { BoardState } from "../../learning/control/state.js";
import { decodeLogSuffix } from "./codec.js";
import type { ReplayWatermark, SnapshotBinding } from "./replay-checkpoint.js";

type ReplayEntry = {
  readonly raw: Buffer;
  readonly state: BoardState;
  readonly lastPhysicalSequence: number;
  readonly checkpoint?: ReplayWatermark;
  readonly checkpointStamp: string;
  readonly baseSnapshot: SnapshotBinding;
};

type MemoHit = {
  readonly state: BoardState;
  readonly mode: "exact" | "suffix";
  readonly replayedRecords: number;
  readonly physicalSequence: number;
  readonly prefixBytes: number;
  readonly checkpoint?: ReplayWatermark;
};

type MemoProof = { readonly checkpoint?: ReplayWatermark; readonly checkpointStamp?: string; readonly baseSnapshot?: SnapshotBinding };

/** Disposable process-local projection, never an authority for unread log bytes. */
export class BoardReplayMemo {
  private readonly entries = new Map<string, ReplayEntry>();
  private bytes = 0;

  // Normal retained learning histories already exceed 140 MiB. Keep the hot
  // verified prefix reusable; exact bytes still prove every hit and eviction
  // still falls back to the authoritative replay path.
  constructor(private readonly maxRoots = 2, private readonly maxBytes = 256 * 1024 * 1024) {}

  read(rootDir: string, raw: Buffer, baseSnapshot: SnapshotBinding = null): MemoHit | undefined {
    const key = path.resolve(rootDir), entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    if (entry.baseSnapshot?.sha256 !== baseSnapshot?.sha256 || entry.baseSnapshot?.generation !== baseSnapshot?.generation) {
      this.forget(key);
      return undefined;
    }

    if (raw.equals(entry.raw)) {
      this.touch(key, entry);
      return { state: structuredClone(entry.state), mode: "exact", replayedRecords: 0, physicalSequence: entry.lastPhysicalSequence, prefixBytes: raw.length,
        ...(entry.checkpoint !== undefined && entry.checkpoint.byteLength <= raw.length ? { checkpoint: entry.checkpoint } : {}) };
    }

    if (raw.length <= entry.raw.length || raw.length > this.maxBytes || raw[raw.length - 1] !== 10 ||
        !raw.subarray(0, entry.raw.length).equals(entry.raw)) {
      this.forget(key);
      return undefined;
    }

    const parsed = decodeLogSuffix(raw.subarray(entry.raw.length).toString("utf8"), entry.lastPhysicalSequence + 1);
    if (!parsed.ok || parsed.discardedTornTail) {
      this.forget(key);
      return undefined;
    }

    // Recovery belongs to the cold snapshot path. Restoring an old missing hash
    // from a new suffix would change an unprovable retry into a successful one.
    let state = structuredClone(entry.state);

    for (const record of parsed.records) {
      const result = reduce(state, record.command);
      if (!result.ok) {
        this.forget(key);
        return undefined;
      }
      state = result.state;
    }

    const physicalSequence = parsed.records.at(-1)?.sequence ?? entry.lastPhysicalSequence;

    this.remember(key, raw, state, physicalSequence, { checkpointStamp: entry.checkpointStamp,
      baseSnapshot: entry.baseSnapshot,
      ...(entry.checkpoint === undefined ? {} : { checkpoint: entry.checkpoint }) });

    return { state, mode: "suffix", replayedRecords: parsed.records.length, physicalSequence, prefixBytes: entry.raw.length,
      ...(entry.checkpoint !== undefined && entry.checkpoint.byteLength <= raw.length ? { checkpoint: entry.checkpoint } : {}) };
  }

  /** Only the authoritative full replay or a validated suffix may publish. */
  remember(rootDir: string, raw: Buffer, state: BoardState, lastPhysicalSequence: number,
    proof: MemoProof = {}): void {
    const key = path.resolve(rootDir);

    this.forget(key);

    if (this.maxRoots <= 0 || raw.length > this.maxBytes || lastPhysicalSequence < 1 || !Number.isInteger(lastPhysicalSequence) ||
        raw.length === 0 || raw[raw.length - 1] !== 10) return;

    while (this.entries.size >= this.maxRoots || this.bytes + raw.length > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.forget(oldest);
    }

    const entry = { raw: Buffer.from(raw), state: structuredClone(state), lastPhysicalSequence,
      baseSnapshot: proof.baseSnapshot ?? null,
      checkpointStamp: proof.checkpointStamp ?? "absent",
      ...(proof.checkpoint === undefined ? {} : { checkpoint: proof.checkpoint }) };

    this.entries.set(key, entry);
    this.bytes += raw.length;
  }

  /** The stamp only invalidates disposable metadata. State authority still
   * requires exact verified log bytes, never an mtime or file-size shortcut. */
  observeCheckpoint(rootDir: string, stamp: string): void {
    const entry = this.entries.get(path.resolve(rootDir));
    if (entry !== undefined && entry.checkpointStamp !== stamp) this.forget(rootDir);
  }

  checkpointWritten(rootDir: string, checkpoint: ReplayWatermark, checkpointStamp: string): void {
    const key = path.resolve(rootDir), entry = this.entries.get(key);
    if (entry !== undefined) this.entries.set(key, { ...entry, checkpoint, checkpointStamp });
  }

  forget(rootDir: string): void {
    const key = path.resolve(rootDir), entry = this.entries.get(key);
    if (entry !== undefined) {
      this.bytes -= entry.raw.length;
      this.entries.delete(key);
    }
  }

  private touch(key: string, entry: ReplayEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}

// Readers and short-lived writers for the same root share one bounded owner.
export const boardReplayMemo = new BoardReplayMemo();
