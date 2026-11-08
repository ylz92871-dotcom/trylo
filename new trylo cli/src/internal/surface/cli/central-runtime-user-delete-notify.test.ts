import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { createFileLedgerPort, USER_LEDGER_FILE } from "../../integration/user-learning/ledger-file.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleMemoryDelete } from "./commands-memory.js";
import { notifyUserDataDeleted } from "./central-runtime-user-delete-notify.js";
import { createUserLearningRuntimeFor, userLearningRoot } from "./user-learning-config.js";
import type { CliContext } from "./context.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-user-delete-notify-")), home = path.join(root, "profile");

  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  const stdout: string[] = [], stderr: string[] = [];
  const ctx: CliContext = { cwd: path.join(root, "caller"), homeDir: root, env: { TRYLO_HOME: home },
    nodeVersion: "test", stdinIsTty: false, readFile: () => undefined, isDirectory: () => false, readDir: () => [],
    writeFile: () => false, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: line => stdout.push(line), stderr: line => stderr.push(line), now: () => 0, newId: prefix => prefix };

  return { root, home, ctx, stdout, stderr };
}

async function observed(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("fixture owner did not observe the source boundary")), 3000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("successful isolated-profile delete wakes two existing owners to read empty source and leaves disabled scopes stopped", async t => {
  const f = fixture(t), userRoot = userLearningRoot(f.ctx.homeDir, f.ctx.env);
  const user = createUserLearningRuntimeFor({ ...f.ctx, workspaceId: "fixture-workspace", warn() {} });

  user.capture({ kind: "turn_start", eventId: "fixture-evidence", sessionId: "fixture-session", turnId: "fixture-turn", payload: { text: "fixture user instruction" } });
  const ledger = createFileLedgerPort(userRoot);
  assert.equal(existsSync(path.join(userRoot, USER_LEDGER_FILE)), true);
  const disabled = runtimeScopePaths(f.home, path.join(f.root, "disabled")), held = tryAcquireRuntimeOwner(disabled);

  assert.ok(held.ok);
  assert.ok(held.value.writeIntent({ schemaVersion: 1, homeRoot: f.home, workspaceRoot: disabled.workspaceRoot,
    enabled: false, configuration: {}, wakeSequence: 4, consumedSequence: 4, wakeReason: "explicit_stop", sourceRefs: [] }).ok);
  const disabledBefore = readFileSync(disabled.intentPath, "utf8");
  const invalid = path.join(f.home, "learning", "runtime", "a".repeat(64));
  mkdirSync(invalid);
  writeFileSync(path.join(invalid, "intent.json"), "{invalid");
  const servers: Awaited<ReturnType<typeof serveCentralRuntime>>[] = [], seen: string[] = [];
  let readyCount = 0, wakeCount = 0, ready!: () => void, woken!: () => void;
  const initial = new Promise<void>(resolve => { ready = resolve; }), notified = new Promise<void>(resolve => { woken = resolve; });

  try {
    for (const workspace of ["first", "second"]) {
      const paths = runtimeScopePaths(f.home, path.join(f.root, workspace));
      servers.push(await serveCentralRuntime({ paths, configuration: {}, driver: { async drive(input) {
        const read = ledger.read();
        assert.ok(read.ok);

        if (input.wake.reason === "owner_recovery") { if (++readyCount === 2) ready(); }
        else {
          assert.equal(input.wake.reason, "explicit_user_learning_data_deleted");
          assert.deepEqual(input.wake.sourceRefs, []);
          assert.deepEqual(read.records, []);
          seen.push(input.scope.workspaceRoot);
          if (++wakeCount === 2) woken();
        }

        return { state: "waiting", reason: "fixture-source-read" };
      } } }));
    }

    await observed(initial);
    // Only this mkdtemp fixture profile is deleted, never the user's profile.
    assert.equal(await handleMemoryDelete(f.ctx, { all: true, json: true }), EXIT_CODES.OK);
    await observed(notified);
    const reply = JSON.parse(f.stdout.join("")) as { notification: { status: string; notifiedScopes: number; issues: unknown[] } };

    assert.equal(reply.notification.notifiedScopes, 2);
    assert.equal(reply.notification.status, "unconfirmed");
    assert.equal(reply.notification.issues.length, 1, "corrupt entry is reported without blocking either valid owner");
    assert.equal(new Set(seen).size, 2);
    assert.equal(existsSync(path.join(userRoot, USER_LEDGER_FILE)), false);
    const saved = readRuntimeIntent(disabled);
    assert.ok(saved.ok);
    assert.equal(saved.value?.enabled, false);
    assert.equal(readFileSync(disabled.intentPath, "utf8"), disabledBefore);
    assert.equal(existsSync(disabled.locatorPath), false);
    assert.equal(existsSync(runtimeScopePaths(f.home, f.ctx.cwd).directory), false, "the caller workspace is never attached");
    assert.match(f.stderr.join(""), /data removed; learning notification unconfirmed/u);
  } finally {
    await Promise.all(servers.map(server => server.close()));
    held.value.close();
  }
});

test("a failed owner notification does not block another scope and discovery exceptions stay post-commit uncertainty", async t => {
  const f = fixture(t), scopes = ["one", "two"].map(name => runtimeScopePaths(f.home, path.join(f.root, name)));
  const reply = await notifyUserDataDeleted(f.ctx, { discover: () => ({ ok: true, value: { scopes, issues: [] } }),
    notify: async (_ctx, input) => input.workspaceRoot === scopes[0]?.workspaceRoot
      ? { ok: false, reason: "runtime_transport_unavailable" } : { ok: true, notified: true } });

  assert.equal(reply.notifiedScopes, 1);
  assert.equal(reply.status, "unconfirmed");
  assert.equal(reply.issues.length, 1);
  const failed = await notifyUserDataDeleted(f.ctx, { discover() { throw new Error("injected read failure"); },
    notify: async () => { throw new Error("unreachable"); } });

  assert.equal(failed.status, "unconfirmed");
  assert.equal(failed.issues[0]?.reason, "runtime_source_discovery_unavailable");
});

test("a diagnostic sink failure cannot turn committed fixture deletion into a failed command", async t => {
  const f = fixture(t), invalid = path.join(f.home, "learning", "runtime", "b".repeat(64));

  mkdirSync(invalid, { recursive: true });
  writeFileSync(path.join(invalid, "intent.json"), "{invalid");
  const userRoot = userLearningRoot(f.ctx.homeDir, f.ctx.env);
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(path.join(userRoot, USER_LEDGER_FILE), "fixture data for removal only");
  const code = await handleMemoryDelete({ ...f.ctx, stderr() { throw new Error("injected diagnostic sink failure"); } }, { all: true, json: true });

  assert.equal(code, EXIT_CODES.OK);
  assert.equal(existsSync(path.join(userRoot, USER_LEDGER_FILE)), false);
  const reply = JSON.parse(f.stdout.join("")) as { notification: { status: string } };

  assert.equal(reply.notification.status, "unconfirmed");
});
