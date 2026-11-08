import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { acquireFactLock, USER_FACTS_COMPACT_FILE, USER_FACTS_FILE, USER_FACTS_LOCK } from "./facts-file.js";
import { USER_LEDGER_FILE } from "./ledger-file.js";

/**
 * "删除全部用户学习数据"在 CLI 侧的那一半（B20）。
 *
 * 面板自己的删除只清 localStorage 与它自己的文件仓库；正式用户账在本目录下。
 * 两边不同时清，"删除全部"就是一句假话——用户看到清空了，`facts.ndjson` 里还留着
 * 他是谁。
 *
 * 在事实 writer 的同一把锁内逐个删除已知数据文件，保留目录与其他所有者的文件。
 * 锁由本次持有者释放，删除操作不能移除其他正在运行的 writer 的锁。
 *
 * 删除**不写墓碑**：删除的语义就是"不存在"。留下删除标记反而会让下一次导入或
 * 备份恢复有东西可复活。
 */

export type MemoryDeleteResult =
  | { readonly ok: true; readonly removed: ReadonlyArray<string>; readonly absent: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

export function deleteUserMemory(root: string): MemoryDeleteResult {
  const targets = [USER_FACTS_FILE, USER_LEDGER_FILE, USER_FACTS_COMPACT_FILE];
  const removed: string[] = [], absent: string[] = [];

  if (!existsSync(root)) return { ok: true, removed, absent: targets };

  const held = acquireFactLock(path.join(root, USER_FACTS_LOCK));
  if (!held.ok) return { ok: false, reason: "facts_locked" };

  try {
    for (const name of targets) {
      const file = path.join(root, name);
      if (!existsSync(file)) {
        absent.push(name);
        continue;
      }

      try {
        rmSync(file, { force: true });
        removed.push(name);
      } catch (error) {
        return { ok: false, reason: `delete_failed:${name}:${messageOf(error)}` };
      }
    }
    return { ok: true, removed, absent };
  } finally { held.release(); }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
