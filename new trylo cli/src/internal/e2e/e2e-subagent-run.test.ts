import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../../cmd/trylo/main.js", import.meta.url));

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-sa-e2e-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, ".trylo"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "subagent-e2e-demo-pkg", version: "1.0.0" }, null, 2),
    "utf8",
  );

  return {
    workspace,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(
  fx: Fixture,
  args: ReadonlyArray<string>,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
  };

  delete env.TRYLO_API_KEY;
  delete env.OPENAI_API_KEY;

  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJournalRows(homeDir: string): Array<Record<string, unknown>> {
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

test("SA-S-3 端到端运行：trylo run --provider fixture-subagent 调度真子代理完成任务并落盘协议", () => {
  const fx = createFixture();
  try {
    const sessionId = "ses-subagent-e2e";
    const res = runCli(fx, [
      "run",
      "inspect package.json with subagent",
      "--provider",
      "fixture-subagent",
      "--session",
      sessionId,
      "--format",
      "stream-json",
    ]);

    assert.equal(res.status, 0, `CLI failed with exit code ${res.status}: ${res.stderr}`);

    // 1. Verify stdout stream contains subagent tool call and completion text
    assert.match(res.stdout, /delegate_subagent/);
    assert.match(res.stdout, /Subagent finished/);

    // 2. Verify durable session journal on disk contains subagent_spawn and subagent_end
    const rows = parseJournalRows(fx.home);

    assert.ok(rows.length > 0, "session journal must not be empty");

    const records = rows.map((r) => (r["record"] ?? r) as Record<string, unknown>);
    const envelopes = records
      .filter((r) => r["type"] === "envelope")
      .map((r) => (r["payload"] as Record<string, unknown>)?.["envelope"] as Record<string, unknown>)
      .filter((env) => env !== undefined);

    const spawnEnvelopes = envelopes.filter((e) => e["kind"] === "subagent_spawn");
    const endEnvelopes = envelopes.filter((e) => e["kind"] === "subagent_end");

    assert.equal(spawnEnvelopes.length, 1, "exactly one subagent_spawn must be in the journal");
    assert.equal(endEnvelopes.length, 1, "exactly one subagent_end must be in the journal");

    const spawnEnv = spawnEnvelopes[0]!;
    const endEnv = endEnvelopes[0]!;

    // 3. Verify lineage & root attempt attribution
    assert.ok(spawnEnv["attemptId"], "spawn envelope must have attemptId");
    assert.ok(endEnv["attemptId"], "end envelope must have attemptId");
    assert.equal(spawnEnv["attemptId"], endEnv["attemptId"], "spawn and end must share root attemptId");

    // 4. Verify subagentId matching between spawn and end
    const spawnPayload = spawnEnv["payload"] as Record<string, unknown>;
    const endPayload = endEnv["payload"] as Record<string, unknown>;

    assert.ok(spawnPayload["subagentId"], "spawn payload must carry subagentId");
    assert.ok(endPayload["subagentId"], "end payload must carry subagentId");
    assert.equal(spawnPayload["subagentId"], endPayload["subagentId"], "spawn and end must match subagentId");
    assert.equal(endPayload["status"], "completed", "subagent end status must be completed");
  } finally {
    fx.cleanup();
  }
});

test("SA-S-5 缺省隔离性：缺省 fixture 运行零子代理副作用，会话日志完全不含 subagent_spawn/end", () => {
  const fx = createFixture();
  try {
    const sessionId = "ses-default-no-subagent";
    const res = runCli(fx, [
      "run",
      "inspect package.json with default fixture",
      "--provider",
      "fixture",
      "--session",
      sessionId,
      "--format",
      "stream-json",
    ]);

    assert.equal(res.status, 0, `CLI failed with exit code ${res.status}: ${res.stderr}`);

    // 1. Stdout has no subagent tool call or subagent event references
    assert.equal(res.stdout.includes("delegate_subagent"), false, "stdout must have no delegate_subagent");
    assert.equal(res.stdout.includes("subagent_spawn"), false, "stdout must have no subagent_spawn");
    assert.equal(res.stdout.includes("subagent_end"), false, "stdout must have no subagent_end");

    // 2. Durable session journal has zero subagent envelopes
    const rows = parseJournalRows(fx.home);
    const records = rows.map((r) => (r["record"] ?? r) as Record<string, unknown>);
    const envelopes = records
      .filter((r) => r["type"] === "envelope")
      .map((r) => (r["payload"] as Record<string, unknown>)?.["envelope"] as Record<string, unknown>)
      .filter((env) => env !== undefined);

    const subagentEnvelopes = envelopes.filter(
      (e) => e["kind"] === "subagent_spawn" || e["kind"] === "subagent_end",
    );

    assert.equal(subagentEnvelopes.length, 0, "default run must have exactly 0 subagent envelopes");
  } finally {
    fx.cleanup();
  }
});

