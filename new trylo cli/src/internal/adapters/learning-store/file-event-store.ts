import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import type { BoardCommand } from "../../learning/control/commands.js";
import { reduce } from "../../learning/control/reducer.js";
import type { ReduceErr, ReduceOk } from "../../learning/control/result.js";
import type { BoardState } from "../../learning/control/state.js";
import type {
  BoardStore,
  StoreLoadErr,
  StoreLoadResult,
} from "../../learning/control/store-port.js";
import { decodeLog, encodeRecord, type LogRecord } from "./codec.js";
import { lockToken, ownsLock, releaseLock, tryAcquireLock, type BoardLockOptions, type LockErr, type LockHandle } from "./lock.js";
import { admitBoardWriter, type BoardWriterAdmissionOptions } from "./writer-admission.js";
import { boardReplayMemo } from "./replay-memo.js";
import { BOARD_LOG_FILE, readBoardLog, readVerifiedBoard, replayCheckpointStamp,
  type BoardReplayReport, type VerifiedBoardLog, type VerifiedBoardRead } from "./board-replay.js";
import { BOARD_SNAPSHOT_FILE, snapshotChecksum, snapshotVersion, type BoardSnapshotFile } from "./board-snapshot.js";
import { checkpointDue, DEFAULT_REPLAY_CHECKPOINT_POLICY, encodeReplayCheckpoint, REPLAY_CHECKPOINT_FILE,
  type ReplayCheckpointPolicy } from "./replay-checkpoint.js";

const LOG_FILE = BOARD_LOG_FILE;
const SNAP_FILE = BOARD_SNAPSHOT_FILE;
const LOCK_FILE = "board-writer.lock";

/**
 * 板日志追加的注入缝，签名与 `appendFileSync` 一致，缺省即真 `appendFileSync`。
 *
 * 只服务故障注入测试（E0M1 P2-3）：逐条 append 不是原子的，要证明「第 k 条中途
 * 失败时前 k-1 条已落盘、调用方拿得到类型化失败、同 writeId 重试幂等补齐」，就需要
 * 一处能让第 N 次 append 抛出的缝。生产路径不传它，行为与从前逐字节一致。
 *
 * 名字刻意不叫 `appendFile`：它是**适配器这一侧**的注入点，而 `integration/method`
 * 的结构守卫（`board.test.ts` T17）禁止方法包源码里出现任何裸 fs 动词——写口只转发
 * 这个不透明选项，自己一行 IO 都没有，名字也不该伪装成一个 fs 调用。
 */
export type LogAppender = (
  file: string,
  data: string,
  encoding: BufferEncoding,
) => void;

export type FileBoardStoreOptions = {
  readonly logAppender?: LogAppender;
  readonly lockOptions?: BoardLockOptions;
  /** Last synchronous admission at the durable boundary, after every asynchronous read. */
  readonly commandGuard?: (command: BoardCommand) => boolean;
  /** Disposable checkpoint maintenance, measured from its persisted prefix. */
  readonly checkpointPolicy?: ReplayCheckpointPolicy;
  /** Read-only counters; neither Board state nor log contents cross this seam. */
  readonly observeReplay?: (report: BoardReplayReport) => void;
};

export type WithBoardWriterOptions = FileBoardStoreOptions & { readonly admission?: BoardWriterAdmissionOptions };

export function createFileBoardStore(
  rootDir: string,
  options: FileBoardStoreOptions = {},
): BoardStore | StoreLoadErr {
  const policy = options.checkpointPolicy ?? DEFAULT_REPLAY_CHECKPOINT_POLICY;
  if (![policy.minimumBytes, policy.minimumRecords].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("Board checkpoint policy requires positive safe integers");
  }

  let lock: LockHandle | LockErr;

  try {
    mkdirSync(rootDir, { recursive: true });
    lock = tryAcquireLock(path.join(rootDir, LOCK_FILE), options.lockOptions);
  } catch (error) {
    // Create/lock IO failed before a single command was applied — a
    // definitely-not-written fault. Collected here, at the adapter boundary, into a
    // typed result so a learning-store failure (boardRoot is a plain file → EEXIST,
    // a permission error, a broken lock) degrades the board instead of throwing
    // through `withBoardWriter` → the write port → the loop into the user's task
    // (audit P1-4). `board_unavailable` is the fail-closed reason the board already
    // reads as "run this turn on an empty archive, write nothing".
    return { ok: false, reason: "board_unavailable", detail: ioDetail(error) };
  }

  if ("ok" in lock) {
    return lock;
  }

  return new FileBoardStore(rootDir, lock, options);
}

export function createBoardReader(rootDir: string, options: Pick<FileBoardStoreOptions, "observeReplay"> = {}): Pick<BoardStore, "load"> {
  return new FileBoardStore(rootDir, { path: "", fd: -1 }, options);
}

export async function withBoardWriter<T>(
  rootDir: string,
  run: (store: BoardStore) => Promise<T>,
  options: WithBoardWriterOptions = {},
): Promise<T | StoreLoadErr> {
  const admission = await admitBoardWriter(() => createFileBoardStore(rootDir, options), options.admission);
  if ("ok" in admission) return admission;

  const { store, beforeRun } = admission;

  try {
    const stopped = beforeRun();
    if (stopped !== undefined) return stopped;
    return await run(store);
  } catch (error) {
    // A throw out of the run body means the outcome is unknown: earlier commands in
    // the sequence may already have appended. Surface a typed failure rather than
    // letting the exception escape into the user's task (audit P1-4). No blind retry
    // here — idempotent `commandId`s make a same-`writeId` retry safe, and deciding
    // to retry is the caller's, not the adapter's.
    return { ok: false, reason: "board_unavailable", detail: ioDetail(error) };
  } finally {
    try {
      await store.close();
    } catch {
      // close() only releases the lock; it cannot un-write an appended record, and a
      // failure here must not mask the run's own result. Cleanup contract: the lock
      // is released best-effort, and if the lock file somehow survives, the next
      // writer's `tryAcquireLock` reports a genuine `multi_writer`.
    }
  }
}

class FileBoardStore implements BoardStore {
  private generation = 0;
  private checkpointWriteSequence = 0;

  constructor(
    private readonly rootDir: string,
    private readonly lock: LockHandle,
    private readonly options: FileBoardStoreOptions,
  ) {}

  async apply(
    command: BoardCommand,
  ): Promise<ReduceOk | ReduceErr | StoreLoadErr> {
    const loaded = await this.loadVerified("append");
    if (!loaded.ok) {
      return loaded;
    }

    const reduced = reduce(loaded.state, command);
    if (!reduced.ok) {
      return reduced;
    }

    if (reduced.idempotent) {
      return reduced;
    }

    await mkdir(this.rootDir, { recursive: true });

    if (loaded.log.tornTail) return this.tornTail();

    const record: LogRecord = {
      sequence: loaded.log.physicalSequence + 1,
      commandId: command.commandId,
      command,
      events: reduced.events,
    };

    if (this.options.commandGuard?.(command) === false) {
      return { ok: false, reason: "collect_disabled", detail: "command rejected at durable write boundary" };
    }

    const encoded = encodeRecord(record);
    if (!this.append(encoded)) return this.lockLost();

    await this.maintainCheckpoint(loaded.log, reduced.state, encoded, command);

    return reduced;
  }

  /** 走注入缝（缺省真 `appendFileSync`），让部分写故障可注入。 */
  private append(body: string): boolean {
    if (!ownsLock(this.lock)) {
      boardReplayMemo.forget(this.rootDir);
      return false;
    }

    const file = path.join(this.rootDir, LOG_FILE);

    try {
      (this.options.logAppender ?? appendFileSync)(file, body, "utf8");
    } catch (error) {
      // A throwing appender may already have written bytes. The next read must
      // rebuild from the authority; preserve the original unknown-write throw.
      boardReplayMemo.forget(this.rootDir);
      throw error;
    }

    return true;
  }

  async load(): Promise<StoreLoadResult> {
    const loaded = await this.loadVerified();
    return loaded.ok ? { ok: true, state: loaded.state, generation: loaded.generation } : loaded;
  }

  private async loadVerified(purpose: "read" | "append" = "read"): Promise<VerifiedBoardRead> {
    try {
      const loaded = await readVerifiedBoard(this.rootDir, this.generation, purpose);
      if (loaded.ok) {
        this.generation = loaded.generation;
        try { this.options.observeReplay?.(loaded.report); }
        catch { /* Diagnostic observers cannot change authoritative read or write results. */ }
      }

      return loaded;
    } catch (error) {
      boardReplayMemo.forget(this.rootDir);
      return { ok: false, reason: "board_unavailable", detail: ioDetail(error) };
    }
  }

  async snapshot(expectedGeneration: number): Promise<StoreLoadResult> {
    const loaded = await this.loadVerified();
    if (!loaded.ok) return loaded;

    // Reload before the CAS: a fresh store may first discover an existing generation here.
    if (expectedGeneration !== this.generation) {
      return { ok: false, reason: "activation_cas_mismatch",
        detail: `expected ${String(expectedGeneration)} got ${String(this.generation)}` };
    }

    if (loaded.log.tornTail) return this.tornTail();

    const generation = this.generation + 1;
    const file: BoardSnapshotFile = { ...snapshotVersion(loaded.state), generation,
      sequence: loaded.state.sequence, checksum: "", state: loaded.state };
    if (!await this.atomicWrite(SNAP_FILE, { ...file, checksum: snapshotChecksum(file) })) return this.lockLost();

    this.generation = generation;

    return { ok: true, state: loaded.state, generation };
  }

  async compact(expectedGeneration: number): Promise<StoreLoadResult> {
    const archiveCheck = await this.load();
    if (!archiveCheck.ok) return archiveCheck;

    // Even root-only budgets change admission. Keep the new-action log barrier so an older reader cannot bypass it after compaction.
    if ((archiveCheck.state.centralLearningBudgets?.length ?? 0) > 0) return this.snapshot(expectedGeneration);

    if ((archiveCheck.state.collaborationV2Facts?.length ?? 0) > 0 || (archiveCheck.state.collaborationV2Archives?.length ?? 0) > 0) {
      return { ok: false, reason: "collaboration_archive_preservation_required",
        detail: "V2 collaboration history is retained in the canonical Board log; use snapshot or V2 hot-projection compaction without truncating that archive" };
    }

    // Keep the causal method log, including its explicit new-command barrier.
    // A v1 reader discards the v2 snapshot and must fail on that command rather
    // than see an empty post-compaction log and start a second history.
    if ((archiveCheck.state.methodExperienceFacts?.length ?? 0) > 0) return this.snapshot(expectedGeneration);

    const snapped = await this.snapshot(expectedGeneration);
    if (!snapped.ok) {
      return snapped;
    }

    const raw = await this.readLogRaw();
    const parsed = decodeLog(raw);
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.discardedTornTail) return this.tornTail();

    const kept = parsed.records.filter((record) => {
      const last =
        record.events.length > 0
          ? record.events[record.events.length - 1]!.sequence
          : 0;
      return last > snapped.state.sequence;
    });
    const body = kept.map(encodeRecord).join("");
    if (!await this.atomicWrite(LOG_FILE, body, true)) return this.lockLost();

    return snapped;
  }

  async close(): Promise<void> {
    if (this.lock.fd < 0) {
      return;
    }
    releaseLock(this.lock);
  }

  private async readLogRaw(): Promise<string> {
    return (await readBoardLog(this.rootDir)).toString("utf8");
  }

  private async maintainCheckpoint(log: VerifiedBoardLog, state: BoardState, encoded: string, command: BoardCommand): Promise<void> {
    // Pure legacy Boards retain their original write frequency. Only the new
    // central/V2 learning histories opt into automatic sidecar maintenance.
    const learningHistory = (state.centralLearningBudgets?.length ?? 0) > 0 || (state.rewardV2Facts?.length ?? 0) > 0
      || (state.collaborationV2Facts?.length ?? 0) > 0 || (state.collaborationV2Archives?.length ?? 0) > 0;
    if (!learningHistory) return;

    const watermark = { byteLength: log.byteLength + Buffer.byteLength(encoded), physicalSequence: log.physicalSequence + 1 };
    if (log.kind !== "append" || !log.checkpointAllowed || !checkpointDue(watermark, log.checkpoint,
      this.options.checkpointPolicy ?? DEFAULT_REPLAY_CHECKPOINT_POLICY)) return;

    try {
      const admitted = () => this.options.commandGuard?.(command) !== false;
      if (!admitted()) return;

      const digest = log.digestPrefix?.digest.copy() ?? createHash("sha256");
      const remainder = log.bytes.subarray(log.digestPrefix?.byteLength ?? 0);
      const prefix = { ...watermark, logicalSequence: state.sequence, sha256: digest.update(remainder).update(encoded, "utf8").digest("hex") };
      const body = encodeReplayCheckpoint(state, prefix, log.baseSnapshot);
      if (await this.writeCheckpoint(body, admitted)) {
        boardReplayMemo.checkpointWritten(this.rootDir, watermark, replayCheckpointStamp(this.rootDir));
      }
    } catch {
      // The original append has definitely succeeded. A disposable index failure
      // must not report that command as failed or induce a second paid action.
      // Append errors never enter this maintenance-only catch.
      boardReplayMemo.forget(this.rootDir);
    }
  }

  private async writeCheckpoint(body: string, admitted: () => boolean): Promise<boolean> {
    if (!admitted() || !ownsLock(this.lock)) return false;

    const target = path.join(this.rootDir, REPLAY_CHECKPOINT_FILE);
    const temporary = `${target}.tmp-${lockToken(this.lock)}-${++this.checkpointWriteSequence}`;
    let phase: "not_created" | "created" | "published" = "not_created";

    try {
      const file = await open(temporary, "wx");
      phase = "created";

      try {
        if (!admitted() || !ownsLock(this.lock)) return false;
        await file.writeFile(body, "utf8");
      } finally { await file.close(); }

      if (!admitted() || !ownsLock(this.lock)) return false;

      renameSync(temporary, target);
      phase = "published";
      return true;
    } finally {
      if (phase === "created") {
        try { await unlink(temporary); }
        catch { /* Best effort, only this attempt's exclusive temporary file; the original append result stays authoritative. */ }
      }
    }
  }

  private async atomicWrite(
    name: string,
    value: unknown,
    raw = false,
  ): Promise<boolean> {
    boardReplayMemo.forget(this.rootDir);
    await mkdir(this.rootDir, { recursive: true });

    if (!ownsLock(this.lock)) return false;

    const target = path.join(this.rootDir, name);
    const tmp = `${target}.tmp-${lockToken(this.lock)}`;
    const body = raw ? String(value) : `${JSON.stringify(value)}\n`;

    await writeFile(tmp, body, "utf8");

    if (!ownsLock(this.lock)) return false;

    renameSync(tmp, target);

    return true;
  }

  private lockLost(): StoreLoadErr {
    return { ok: false, reason: "multi_writer", detail: "Board writer ownership or recovery fence changed before durable write" };
  }

  private tornTail(): StoreLoadErr {
    return { ok: false, reason: "torn_write", detail: "Board log has an incomplete tail; explicitly repair it before writing" };
  }
}

/**
 * Turn a raw IO throw into the human-readable `detail` of a typed failure.
 *
 * The failure *contract* is the `reason` code (`board_unavailable`); the detail is
 * only diagnostic context for whoever reads the degraded observation, so an
 * `Error.message` is kept verbatim and a non-Error throw is stringified. Nothing
 * here re-inspects the error to pick a different reason — the adapter boundary has
 * already decided, by *phase*, whether the write is definitely-not-written (create/
 * lock), partially-written (`archive_write_failed`, raised in the write port), or
 * unknown (a throw out of the run body).
 */
function ioDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
