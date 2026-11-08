import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compareTraces, normalizeJson } from "./golden-trace.js";
import { GOLDEN_RUN_TRACE } from "./golden-run-trace.js";
import { createNdjsonSessionStore } from "../adapters/session-store/ndjson.js";
import { compactSession } from "../surface/cli/compact-session.js";

/**
 * W1 End-to-end Whole Machine Path (WP 2026-09-17 地基收口 W1):
 *
 * `trylo run "一句任务" → fixture provider → workspace 工具 + approval → 会话日志 → 崩溃恢复（checkpoint）→ compact → resume 续跑→终态`
 *
 * This test runs the real CLI binary across the full delivery path, verifying
 * that each port and adapter along the path is consumed in production,
 * checkpoints are taken before workspace mutations, compaction is recorded in
 * the session journal, checkpoints can restore workspace state on crash, and
 * resumed runs project under the compacted window.
 */

const cli = fileURLToPath(new URL("../../cmd/trylo/main.js", import.meta.url));

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function createFixture(contextTokenLimit?: number): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-e2e-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, ".trylo"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "e2e-groundwork-fixture", version: "1.0.0" }, null, 2),
    "utf8",
  );

  if (contextTokenLimit !== undefined) {
    writeFileSync(
      join(workspace, ".trylo", "config.json"),
      JSON.stringify({ contextTokenLimit }, null, 2),
      "utf8",
    );
  }

  return {
    workspace,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(
  fx: Fixture,
  args: ReadonlyArray<string>,
  input?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
  };

  delete env.TRYLO_API_KEY;
  delete env.OPENAI_API_KEY;

  const result = spawnSync(process.execPath, [cli, ...args, ...(args[0] === "run" ? ["--tools=read_file,write_file"] : [])], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(JSON.parse(trimmed) as Record<string, unknown>);
  }

  return rows;
}

function journalRows(homeDir: string): Array<Record<string, unknown>> {
  const sessionsDir = join(homeDir, "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];

  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith(".ndjson")) {
      continue;
    }

    const sessionFile = join(sessionsDir, entry);

    for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        rows.push(JSON.parse(trimmed) as Record<string, unknown>);
      }
    }
  }

  return rows;
}

/** Use the same production compaction operation as the REPL on the CLI's
 * durable session. Automatic budget compaction is covered by socket tests;
 * this whole-machine fixture must not require discarding user constraints.
 */
async function compactFixture(fx: Fixture, sessionId: string): Promise<void> {
  const store = createNdjsonSessionStore({ path: join(fx.home, "sessions", `${sessionId}.ndjson`) });
  try {
    assert.equal((await store.attach()).ok, true);
    const read = await store.readRecords();

    assert.equal(read.ok, true);

    if (!read.ok) return;

    const compacted = await compactSession({ now: () => Date.now() }, sessionId, read.view.records, store);

    assert.equal(compacted.ok, true);
    assert.ok(compacted.ok && compacted.wrote);
  } finally { await store.release(); }
}

test("W1 端到端整机路径：用户任务 → fixture-write → 工具写+自检 → 检查点快照 → 压缩窗口 → 会话持久化", async () => {
  const fx = createFixture(4096);
  try {
    const sessionId = "ses-e2e-w1";
    const taskPrompt = "execute groundwork mutation task and verify the written file";
    const res = runCli(fx, [
      "run",
      taskPrompt,
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--session",
      sessionId,
      "--format",
      "stream-json",
    ]);

    assert.equal(res.status, 0, `CLI failed with exit code ${res.status}: ${res.stderr}`);
    await compactFixture(fx, sessionId);

    // 1. Tool execution wrote file and verified content
    const writtenFile = join(fx.workspace, "fixture-output.txt");

    assert.equal(existsSync(writtenFile), true, "fixture-output.txt was created by tool");
    const writtenContent = readFileSync(writtenFile, "utf8");

    assert.equal(writtenContent, "the fixture wrote this line");

    // 2. Checkpoint was taken BEFORE the write landed
    const checkpointsDir = join(fx.home, "checkpoints");

    assert.equal(existsSync(checkpointsDir), true, "checkpoints directory exists");
    const checkpoints = readdirSync(checkpointsDir).filter((f) => f.startsWith("cp-"));

    assert.equal(checkpoints.length >= 1, true, "at least one checkpoint snapshot was taken");

    // 3. Durable journal recorded session, checkpoint observation, compaction, and turn result
    const jRows = journalRows(fx.home);
    const eventTypes = jRows.map((r) => {
      const rec = r["record"] as { type?: string } | undefined;
      return rec?.type;
    });

    assert.equal(eventTypes.includes("session_start"), true, "journal contains session_start");
    assert.equal(eventTypes.includes("turn_start"), true, "journal contains turn_start");
    assert.equal(eventTypes.includes("compact"), true, "journal contains compact record");
    assert.equal(eventTypes.includes("terminal"), true, "journal contains terminal record");

    // 4. Normalized stream-json event sequence matches golden trace
    const events = parseJsonLines(res.stdout);
    const normEvents = events.map((e) =>
      normalizeJson(e, { workspaceRoot: fx.workspace, homeRoot: fx.home }),
    );

    // Strip volatile fields for golden comparison
    const sanitized = normEvents.map((e) => {
      const copy = { ...e };
      if ("model" in copy) {
        delete copy["model"];
      }
      return copy;
    });

    const comp = compareTraces(sanitized, GOLDEN_RUN_TRACE);

    assert.equal(comp.matches, true, comp.diff);
  } finally {
    fx.cleanup();
  }
});

test("W1 崩溃恢复：通过 checkpoint restore 恢复损坏的工作区", () => {
  const fx = createFixture();
  try {
    const sessionId = "ses-e2e-crash-recovery";
    const res = runCli(fx, [
      "run",
      "perform write before crash",
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--session",
      sessionId,
      "--format",
      "text",
    ]);

    assert.equal(res.status, 0, res.stderr);

    // Verify file written
    const targetFile = join(fx.workspace, "fixture-output.txt");

    assert.equal(existsSync(targetFile), true);

    // List checkpoints
    const listRes = runCli(fx, ["checkpoint", "list", "--json"]);

    assert.equal(listRes.status, 0);
    const listed = JSON.parse(listRes.stdout) as ReadonlyArray<{ checkpointId: string }>;

    assert.equal(listed.length >= 1, true);
    const checkpointId = listed[0]!.checkpointId;

    // Simulate crash / data corruption
    writeFileSync(targetFile, "CORRUPTED_AFTER_CRASH", "utf8");
    assert.equal(readFileSync(targetFile, "utf8"), "CORRUPTED_AFTER_CRASH");

    // Restore from checkpoint
    const restoreRes = runCli(fx, ["checkpoint", "restore", checkpointId]);

    assert.equal(restoreRes.status, 0, restoreRes.stderr);

    // Verify recovery: before the write, fixture-output.txt did not exist!
    assert.equal(
      existsSync(targetFile),
      false,
      "restored checkpoint removed file created after snapshot",
    );
    // package.json remains intact
    const pkg = JSON.parse(readFileSync(join(fx.workspace, "package.json"), "utf8")) as { name: string };

    assert.equal(pkg.name, "e2e-groundwork-fixture");
  } finally {
    fx.cleanup();
  }
});

test("W1 会话续跑（resume）：从压缩窗口继续对话并到达终态", async () => {
  const fx = createFixture(4096);
  try {
    const sessionId = "ses-e2e-resume";
    const initialPrompt = "initial turn to create a durable session";
    const firstRes = runCli(fx, [
      "run",
      initialPrompt,
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--session",
      sessionId,
      "--format",
      "stream-json",
    ]);

    assert.equal(firstRes.status, 0, firstRes.stderr);
    await compactFixture(fx, sessionId);

    // Second turn resumes the session
    const resumeRes = runCli(fx, [
      "run",
      "continue with follow up task",
      "--resume",
      sessionId,
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--format",
      "stream-json",
    ]);

    assert.equal(resumeRes.status, 0, resumeRes.stderr);

    const resumeEvents = parseJsonLines(resumeRes.stdout);
    const finishEvent = resumeEvents.find((e) => e["type"] === "run_result");

    assert.notEqual(finishEvent, undefined);
    assert.equal(finishEvent?.["status"], "completed");
    assert.equal(finishEvent?.["finishReason"], "stop");
  } finally {
    fx.cleanup();
  }
});

test("反方/红例：篡改 Golden Trace 必报错（回放一致性保证）", () => {
  const mockTrace = [{ type: "run_start" }, { type: "tampered_event" }];
  const expectedTrace = [{ type: "run_start" }, { type: "tool_use" }];
  const comp = compareTraces(mockTrace, expectedTrace);
  assert.equal(comp.matches, false, "tampered trace must not match");
  assert.equal(comp.diff !== undefined, true);
});
