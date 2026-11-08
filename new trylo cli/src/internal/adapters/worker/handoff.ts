import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HandoffRecord, HandoffState, WorkerIdentity } from "../../ports/worker.js";

/**
 * 交接记录的落盘（WP26 / A04）。
 *
 * ## 为什么需要它
 *
 * 「先删再跑」真正的毛病不是删，而是**删除本身成了唯一的领取事实**：删了就再也
 * 说不清这条去了哪里。交接窗口里崩一下，队列项没了、owner 收没收到也不知道，
 * 两个方向都是坏的 —— 补一句会跑两遍，不补就悄悄丢了。
 *
 * 所以领取事实由这份记录承载：写了它才算「我接手了」，队列项删不删是**之后**的
 * 事，崩了也能照着它把状态问回来。
 *
 * ## 为什么按 key 覆盖而不是追加
 *
 * 同一个 `(sessionId, messageId)` 的记录只会有一条，后写的覆盖先写的 —— 这正是
 * 状态迁移（`handing_off` → `acked`）要的形状。做成追加会让「现在是什么状态」
 * 变成分辨最后一行，而分辨最后一行在文件被并发写过一次之后就不再可靠。
 */

export type HandoffStore = {
  readonly list: () => Promise<ReadonlyArray<HandoffRecord>>;
  /** 写入（同 key 覆盖）。返回是否落盘。 */
  readonly put: (record: HandoffRecord) => Promise<boolean>;
  readonly remove: (sessionId: string, messageId: string) => Promise<boolean>;
  /** 一条记录；没有就说没有。 */
  readonly get: (sessionId: string, messageId: string) => Promise<HandoffRecord | undefined>;
};

export function handoffKey(sessionId: string, messageId: string): string {
  return `${sessionId}@${messageId}`;
}

const STATES: ReadonlyArray<HandoffState> = ["handing_off", "acked", "unknown"];

function isIdentity(value: unknown): value is WorkerIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["pid"] === "number" && typeof record["startedAtMs"] === "number";
}

function isRecord(value: unknown): value is HandoffRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record["sessionId"] === "string" &&
    typeof record["messageId"] === "string" &&
    typeof record["text"] === "string" &&
    typeof record["state"] === "string" &&
    STATES.includes(record["state"] as HandoffState) &&
    typeof record["startedAtMs"] === "number" &&
    isIdentity(record["worker"])
  );
}

function encode(record: HandoffRecord): string {
  const flat: Record<string, unknown> = {
    sessionId: record.sessionId,
    messageId: record.messageId,
    text: record.text,
    state: record.state,
    startedAtMs: record.startedAtMs,
    worker: record.worker,
  };

  if (record.ownerRef !== undefined) {
    flat["ownerRef"] = record.ownerRef;
  }

  if (record.detail !== undefined) {
    flat["detail"] = record.detail;
  }

  return `${JSON.stringify(flat)}\n`;
}

function decode(raw: string): ReadonlyArray<HandoffRecord> {
  if (raw.trim().length === 0) {
    return [];
  }

  const out: HandoffRecord[] = [];

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      // 一行坏了就整份拒读：跳过去会让后面的状态迁移建立在半份记录上。
      throw new Error("handoff store is unreadable");
    }

    if (!isRecord(parsed)) {
      throw new Error("handoff store is unreadable");
    }

    const withOptional: HandoffRecord = {
      ...parsed,
      ...(parsed.ownerRef === undefined ? {} : { ownerRef: parsed.ownerRef }),
      ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
    };

    out.push(withOptional);
  }

  return out;
}

/**
 * 一份交接记录。
 *
 * 写入走「临时文件 + 改名」，因为改名在同一文件系统上是唯一的原子操作：读的人
 * 看到的全是旧的那份、或全是新的那份，不会看到一个解码成坏记录的前缀。
 */
export function createFileHandoffStore(options: { readonly file: string }): HandoffStore {
  const read = (): ReadonlyArray<HandoffRecord> => {
    if (!existsSync(options.file)) {
      return [];
    }
    return decode(readFileSync(options.file, "utf8"));
  };
  const writeAll = (records: ReadonlyArray<HandoffRecord>): boolean => {
    const dir = path.dirname(options.file);
    mkdirSync(dir, { recursive: true });
    const temp = `${options.file}.tmp`;
    writeFileSync(temp, records.map(encode).join(""), "utf8");
    renameSync(temp, options.file);
    return true;
  };

  return {
    list: async () => read(),
    get: async (sessionId, messageId) => {
      const key = handoffKey(sessionId, messageId);
      return read().find((record) => handoffKey(record.sessionId, record.messageId) === key);
    },
    put: async (record) => {
      const key = handoffKey(record.sessionId, record.messageId);
      const current = read();
      const next = current.filter(
        (item) => handoffKey(item.sessionId, item.messageId) !== key,
      );

      next.push(record);

      return writeAll(next);
    },
    remove: async (sessionId, messageId) => {
      const key = handoffKey(sessionId, messageId);
      const next = read().filter(
        (item) => handoffKey(item.sessionId, item.messageId) !== key,
      );
      return writeAll(next);
    },
  };
}
