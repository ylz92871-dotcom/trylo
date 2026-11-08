import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import { openSession } from "./session-open.js";
import { sessionPath, sessionsDir } from "./session-paths.js";

/**
 * D5 P2-1: `--resume` 失败的提示语必须分场景。
 *
 * `missing_session`（会根本不存在）指路 `trylo session list`；删锁提示只属于
 * 真实的 `lock_conflict`。一刀切的文案让前一种场景的用户去删一个不存在的锁。
 */

const PRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
  workspaceId: "w",
};

function ctxFor(homeDir: string): CliContext {
  return {
    env: {},
    homeDir,
    cwd: homeDir,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };
}

function failureOf(opened: Awaited<ReturnType<typeof openSession>>): { message: string; hint: string } {
  assert.equal(opened.kind, "failed", `expected a failure, got ${opened.kind}`);
  if (opened.kind !== "failed") {
    throw new Error("unreachable");
  }
  return { message: opened.failure.message, hint: opened.failure.hint };
}

test("D5: resuming a missing session points at `trylo session list`, not at a lock file", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-resume-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const failure = failureOf(await openSession(ctxFor(home), { message: [], readStdin: false, resume: "nope" }, PRINT));
  assert.match(failure.message, /cannot resume session nope: missing_session/);
  assert.match(failure.hint, /trylo session list/);
  assert.equal(failure.hint.includes(".lock"), false, "there is no lock file in this scenario");
});

test("D5: a real lock conflict keeps the stale-lock hint", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-resume-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(sessionsDir(home, {}), { recursive: true });
  // 先有 journal 再有锁：attach 越过 missing_session，倒在 acquireLock。
  writeFileSync(sessionPath(home, {}, "busy"), "{}\n");
  writeFileSync(`${sessionPath(home, {}, "busy")}.lock`, `${process.pid}\n`);
  const failure = failureOf(await openSession(ctxFor(home), { message: [], readStdin: false, resume: "busy" }, PRINT));

  assert.match(failure.message, /cannot resume session busy: lock_conflict/);
  assert.match(failure.hint, /\.lock/);
});
