import { SESSION_FORMAT_VERSION } from "../../ports/session.js";
import { SESSION_JOURNAL_SUFFIX } from "../../adapters/session-store/session-meta.js";

/**
 * Where durable sessions live on disk, and how they are named.
 *
 * A session id becomes a filename, so it is validated before use: an id that
 * could escape the sessions directory is rejected rather than sanitised, since
 * silently rewriting a user's id would break `--resume`.
 */

export const SESSION_FILE_SUFFIX = SESSION_JOURNAL_SUFFIX;

export type SessionFileInfo = {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
  readonly formatVersion: string;
};

export type SessionDirIo = {
  readonly readDir: (
    absolutePath: string,
  ) => ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly modifiedAtMs: number }>;
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && !value.includes("..");
}

export function tryloHome(homeDir: string, env: Readonly<Record<string, string | undefined>>): string {
  const override = env["TRYLO_HOME"];
  return override !== undefined && override.length > 0 ? override : `${homeDir}/.trylo`;
}

export function sessionsDir(homeDir: string, env: Readonly<Record<string, string | undefined>>): string {
  return `${tryloHome(homeDir, env)}/sessions`;
}

/**
 * 持久后台队列的位置：`tryloHome/queue/<sessionId>.ndjson`（WP08 / C41）。
 *
 * 与 `sessionsDir`、`permissionLedgerPath` 同一条纪律：路径只从这一个家公式派生。
 * 队列文件按会话分片而不是按会话目录嵌套，因为 `trylo queue --message` 必须在
 * **会话不在场**时也能定位到它的队列 —— 那个时刻没有任何会话目录被打开过。
 */
export function sessionQueuePath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  sessionId: string,
): string {
  return `${tryloHome(homeDir, env)}/queue/${sessionId}.ndjson`;
}

/**
 * 持久 Permission 账本的位置：`tryloHome/permission/ledger.ndjson`。
 *
 * 与 `sessionsDir` 同一条纪律：路径只从这一个家公式派生，调用方不再拼第二遍。
 * 重抄一份会在 `TRYLO_HOME` 被设置的那天变成「两个家只搬一个」。
 */
export function permissionLedgerPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return `${tryloHome(homeDir, env)}/permission/ledger.ndjson`;
}

export function sessionPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  sessionId: string,
): string {
  return `${sessionsDir(homeDir, env)}/${sessionId}${SESSION_FILE_SUFFIX}`;
}

/** Newest first: the session a user most likely means by "the last one". */
export function listSessions(io: SessionDirIo, dir: string): ReadonlyArray<SessionFileInfo> {
  const entries = io.readDir(dir);
  const sessions: SessionFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(SESSION_FILE_SUFFIX)) {
      continue;
    }

    const id = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
    if (!isValidSessionId(id)) {
      continue;
    }

    sessions.push({
      id,
      path: `${dir}/${entry.name}`,
      bytes: entry.bytes,
      modifiedAtMs: entry.modifiedAtMs,
      formatVersion: SESSION_FORMAT_VERSION,
    });
  }

  return sessions.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
}
