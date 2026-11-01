import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { BoardCommand } from "../../learning/control/commands.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { reduce } from "../../learning/control/reducer.js";
import { recoverMethodCommandIdentities } from "../../learning/control/method-replay.js";
import type { ReduceErr, ReduceOk } from "../../learning/control/result.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "../../learning/control/state.js";
import type {
  BoardStore,
  StoreLoadErr,
  StoreLoadResult,
} from "../../learning/control/store-port.js";
import { decodeLog, encodeRecord, type LogRecord } from "./codec.js";
import { releaseLock, tryAcquireLock, type LockErr, type LockHandle } from "./lock.js";

const LOG_FILE = "board-events.ndjson";
const SNAP_FILE = "board-snapshot.json";
const LOCK_FILE = "board-writer.lock";

type SnapshotFile = {
  readonly generation: number;
  readonly sequence: number;
  readonly checksum: string;
  readonly state: BoardState;
};

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
};

export function createFileBoardStore(
  rootDir: string,
  options: FileBoardStoreOptions = {},
): BoardStore | StoreLoadErr {
  let lock: LockHandle | LockErr;
  try {
    mkdirSync(rootDir, { recursive: true });
    lock = tryAcquireLock(path.join(rootDir, LOCK_FILE));
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

export function createBoardReader(rootDir: string): Pick<BoardStore, "load"> {
  return new FileBoardStore(rootDir, { path: "", fd: -1 }, {});
}

export async function withBoardWriter<T>(
  rootDir: string,
  run: (store: BoardStore) => Promise<T>,
  options: FileBoardStoreOptions = {},
): Promise<T | StoreLoadErr> {
  const store = createFileBoardStore(rootDir, options);
  if (!("apply" in store)) {
    return store;
  }
  try {
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

  constructor(
    private readonly rootDir: string,
    private readonly lock: LockHandle,
    private readonly options: FileBoardStoreOptions,
  ) {}

  async apply(
    command: BoardCommand,
  ): Promise<ReduceOk | ReduceErr | StoreLoadErr> {
    const loaded = await this.load();
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
    const record: LogRecord = {
      sequence: nextLogSequence(await this.readLogRaw()),
      commandId: command.commandId,
      command,
      events: reduced.events,
    };
    this.append(encodeRecord(record));
    return reduced;
  }

  /** 走注入缝（缺省真 `appendFileSync`），让部分写故障可注入。 */
  private append(body: string): void {
    const file = path.join(this.rootDir, LOG_FILE);
    (this.options.logAppender ?? appendFileSync)(file, body, "utf8");
  }

  async load(): Promise<StoreLoadResult> {
    try {
      const snapshot = await this.readSnapshot();
      if (snapshot !== undefined && !snapshot.ok) {
        return snapshot;
      }
      const raw = await this.readLogRaw();
      const parsed = decodeLog(raw);
      if (!parsed.ok) {
        return parsed;
      }
      // A damaged compacted checkpoint has no complete history to replay.
      // Physical log sequence restarts after compaction; the first logical
      // event must still be 1 to prove a complete replay from an empty Board.
      const completeReplay = parsed.records[0]?.events[0]?.sequence === 1;
      if (snapshot === undefined && !completeReplay && (existsSync(path.join(this.rootDir, SNAP_FILE)) || parsed.records.length > 0)) {
        return { ok: false, reason: "snapshot_corrupt", detail: "checkpoint is unavailable and the retained log cannot rebuild the complete Board" };
      }
      // `readSnapshot` already decoded+guarded the snapshot state (P2-4), so it is a
      // valid `BoardState` here; no second normalize. A dropped/corrupt snapshot is
      // `undefined`, and we start from empty and let the log replay rebuild everything.
      let state = snapshot !== undefined && snapshot.ok ? snapshot.state : emptyBoardState();
      state = recoverMethodCommandIdentities(state, parsed.records.map(record => record.command));
      for (const record of parsed.records) {
        const reduced = reduce(state, record.command);
        if (!reduced.ok) {
          return { ok: false, reason: reduced.reason, detail: reduced.detail };
        }
        state = reduced.state;
      }
      return { ok: true, state, generation: this.generation };
    } catch (error) {
      // Read-phase IO fault that survived the per-file handling below (e.g. the log
      // is a directory, or an unreadable parent): fail closed as a typed result so
      // the board degrades to an empty archive instead of throwing into the caller's
      // task (audit P1-4). The log is authoritative, so nothing is fabricated here.
      return { ok: false, reason: "board_unavailable", detail: ioDetail(error) };
    }
  }

  async snapshot(expectedGeneration: number): Promise<StoreLoadResult> {
    if (expectedGeneration !== this.generation) {
      return {
        ok: false,
        reason: "activation_cas_mismatch",
        detail: `expected ${String(expectedGeneration)} got ${String(this.generation)}`,
      };
    }
    const loaded = await this.load();
    if (!loaded.ok) {
      return loaded;
    }
    const generation = this.generation + 1;
    const file: SnapshotFile = {
      generation,
      sequence: loaded.state.sequence,
      checksum: "",
      state: loaded.state,
    };
    const checksum = sha256Hex(
      canonicalJson({ generation, sequence: file.sequence, state: file.state }),
    );
    await this.atomicWrite(SNAP_FILE, { ...file, checksum });
    this.generation = generation;
    return { ok: true, state: loaded.state, generation };
  }

  async compact(expectedGeneration: number): Promise<StoreLoadResult> {
    const snapped = await this.snapshot(expectedGeneration);
    if (!snapped.ok) {
      return snapped;
    }
    const raw = await this.readLogRaw();
    const parsed = decodeLog(raw);
    if (!parsed.ok) {
      return parsed;
    }
    const kept = parsed.records.filter((record) => {
      const last =
        record.events.length > 0
          ? record.events[record.events.length - 1]!.sequence
          : 0;
      return last > snapped.state.sequence;
    });
    const body = kept.map(encodeRecord).join("");
    await this.atomicWrite(LOG_FILE, body, true);
    return snapped;
  }

  async close(): Promise<void> {
    if (this.lock.fd < 0) {
      return;
    }
    releaseLock(this.lock);
  }

  private async readLogRaw(): Promise<string> {
    const file = path.join(this.rootDir, LOG_FILE);
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if (isNotFound(err)) {
        return "";
      }
      throw err;
    }
  }

  private async readSnapshot(): Promise<StoreLoadResult | undefined> {
    const file = path.join(this.rootDir, SNAP_FILE);
    if (!existsSync(file)) {
      return undefined;
    }
    let parsed: SnapshotFile;
    try {
      const raw = readFileSync(file, "utf8");
      parsed = JSON.parse(raw) as SnapshotFile;
    } catch {
      // A snapshot we cannot read or parse is a dropped cache, not a fatal fault:
      // return `undefined` so `load` replays the authoritative log and rebuilds the
      // state. This is the same recovery as a checksum mismatch below — the snapshot
      // is never the source of truth, so losing it costs a replay, not correctness.
      return undefined;
    }
    const checksum = sha256Hex(
      canonicalJson({
        generation: parsed.generation,
        sequence: parsed.sequence,
        state: parsed.state,
      }),
    );
    if (checksum !== parsed.checksum) {
      return undefined;
    }
    // P2-4: a snapshot whose fieldings/feedbacks elements fail the decode guards is
    // corrupt exactly like a checksum mismatch — drop it and let `load` replay the
    // authoritative log, which rebuilds both ledgers from real commands.
    const normalized = normalizeBoardState(parsed.state);
    if (normalized === undefined) {
      return undefined;
    }
    this.generation = parsed.generation;
    return { ok: true, state: normalized, generation: parsed.generation };
  }

  private async atomicWrite(
    name: string,
    value: unknown,
    raw = false,
  ): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, name);
    const tmp = `${target}.tmp`;
    const body = raw ? String(value) : `${JSON.stringify(value)}\n`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, target);
  }
}

function nextLogSequence(raw: string): number {
  const parsed = decodeLog(raw);
  if (!parsed.ok) {
    return 1;
  }
  if (parsed.records.length === 0) {
    return 1;
  }
  return parsed.records[parsed.records.length - 1]!.sequence + 1;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
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
