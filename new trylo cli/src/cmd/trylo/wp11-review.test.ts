import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createFileCheckpointStore } from "../../internal/adapters/checkpoint/store.js";
import { createNdjsonSessionStore } from "../../internal/adapters/session-store/ndjson.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../internal/ports/session.js";

/**
 * WP11/F11: review commands through the real binary.
 *
 * Handler tests prove the logic; these prove the seams — arg parsing,
 * dispatch (`commands.ts`), and stdio — are actually connected. Each case
 * runs `dist/cmd/trylo/main.js` in a child process with a hermetic home, so
 * a disconnected case or a missing `--json` surfaces here and nowhere else.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "default",
  toolCatalogHash: "catalog",
  workspaceId: "workspace",
};

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-wp11-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fx: Fixture, args: readonly string[], input?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  delete env.TRYLO_API_KEY;
  env.USERPROFILE = fx.home;
  env.HOME = fx.home;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("F11 `diff` outside a git repository reports so and leaves with 0", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["diff"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not a git repository/);
    const machine = run(fx, ["diff", "--json"]);
    assert.equal(machine.status, 0, machine.stderr);
    assert.deepEqual(JSON.parse(machine.stdout), { isGitRepo: false, diff: "" });
  } finally {
    fx.cleanup();
  }
});

test("F11 `diff` inside a git repository shows untracked files", () => {
  const fx = fixture();
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: fx.workspace });
    if (init.status !== 0) {
      assert.fail("git is required for this case");
    }

    writeFileSync(join(fx.workspace, "new.txt"), "hello-untracked\n", "utf8");
    const result = run(fx, ["diff"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hello-untracked/);
  } finally {
    fx.cleanup();
  }
});

test("F11 `checkpoint diff` previews a restore and refuses unknown ids", async () => {
  const fx = fixture();
  try {
    const storage = join(fx.home, "checkpoints");
    const store = createFileCheckpointStore({ workspaceRoot: fx.workspace, storageRoot: storage });

    writeFileSync(join(fx.workspace, "a.ts"), "before", "utf8");
    const taken = await store.snapshot({
      workspaceRoot: fx.workspace,
      label: "before:write",
      createdAt: "2026-10-05T00:00:00.000Z",
    });

    assert.equal(taken.ok, true);

    if (!taken.ok) {
      return;
    }

    writeFileSync(join(fx.workspace, "a.ts"), "after", "utf8");
    const result = run(fx, ["checkpoint", "diff", taken.value.checkpointId]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /M a\.ts/);
    const missing = run(fx, ["checkpoint", "diff", "cp-does-not-exist"]);

    assert.equal(missing.status, 52, missing.stderr);
  } finally {
    fx.cleanup();
  }
});

test("F11 `checkpoint restore --only` rewinds in scope and keeps user files", async () => {
  const fx = fixture();
  try {
    const storage = join(fx.home, "checkpoints");
    const store = createFileCheckpointStore({ workspaceRoot: fx.workspace, storageRoot: storage });

    writeFileSync(join(fx.workspace, "task.ts"), "before", "utf8");
    const taken = await store.snapshot({
      workspaceRoot: fx.workspace,
      label: "before:write",
      createdAt: "2026-10-05T00:00:00.000Z",
    });

    assert.equal(taken.ok, true);

    if (!taken.ok) {
      return;
    }

    const id = taken.value.checkpointId;

    writeFileSync(join(fx.workspace, "task.ts"), "after", "utf8");
    writeFileSync(join(fx.workspace, "mine.txt"), "user file", "utf8");
    const result = run(fx, ["checkpoint", "restore", id, "--only", "task.ts"]);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /scoped to 1 path/);
    assert.equal(readFileSync(join(fx.workspace, "task.ts"), "utf8"), "before");
    assert.equal(readFileSync(join(fx.workspace, "mine.txt"), "utf8"), "user file");
  } finally {
    fx.cleanup();
  }
});

test("F11 `session review` shows one turn through the binary", async () => {
  const fx = fixture();
  try {
    const sessionId = "wp11-e2e";

    mkdirSync(join(fx.home, "sessions"), { recursive: true });
    const store = createNdjsonSessionStore({ path: join(fx.home, "sessions", `${sessionId}.ndjson`) });
    const started = await store.start({ sessionId, createdAt: "2026-10-05T00:00:00.000Z", fingerprint: FINGERPRINT });

    assert.equal(started.ok, true);
    const appended = await store.append({
      type: "transcript_item",
      sessionId,
      turnId: "turn-1",
      at: "2026-10-05T00:00:01.000Z",
      payload: { kind: "user", sequence: 0, text: "fix it" },
    });

    assert.equal(appended.ok, true);
    await store.release();
    const result = run(fx, ["session", "review", sessionId]);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /turn turn-1/);
    const machine = run(fx, ["session", "review", sessionId, "--json"]);

    assert.equal(machine.status, 0, machine.stderr);
    const parsed = JSON.parse(machine.stdout) as { turn: { turnId: string } };

    assert.equal(parsed.turn.turnId, "turn-1");
  } finally {
    fx.cleanup();
  }
});

test("F11 a piped REPL runs /diff and /review, not just the first slash", () => {
  const fx = fixture();
  try {
    const result = run(fx, [], "/diff\n/review\n");
    const said = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, said);
    assert.match(said, /not a git repository/, "the /diff command never ran");
    assert.match(said, /no turns yet/, "the /review command never ran");
  } finally {
    fx.cleanup();
  }
});
