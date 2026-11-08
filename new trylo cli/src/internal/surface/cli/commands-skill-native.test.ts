import assert from "node:assert/strict";
import test from "node:test";
import { handleSkillNative } from "./commands-skill-native.js";
import type { CliContext } from "./context.js";

function fixture(stdin: string) {
  const out: string[] = [], warnings: string[] = [];
  const ctx: CliContext = { env: {}, homeDir: "home", cwd: "workspace", nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => false,
    readStdin: async () => stdin, readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => out.push(text), stderr: text => warnings.push(text), now: () => 0, newId: prefix => prefix };
  return { ctx, out, warnings };
}

test("native skill CLI preserves exact reviewed identity and original failed/committed bodies", async () => {
  const params = { subsystem: "skills", id: "native-pending", expectedHash: "reviewed-hash", reason: "User approval" };
  const h = fixture(JSON.stringify(params));
  let closed = false;
  const body = { ok: false, result: { committed: false, snapshotId: "native-snapshot", id: params.id }, error: "stale hash" };

  assert.equal(await handleSkillNative(h.ctx, { subsystem: "skill", nativeMethod: "pendingApply" }, () => ({
    compatibility: async (method, input) => {
      assert.equal(method, "pendingApply");
      assert.deepEqual(input, params);
      return body;
    }, close: () => { closed = true; },
  })), 0);
  assert.deepEqual(JSON.parse(h.out[0]!), { schemaVersion: 1, subsystem: "skill", method: "pendingApply", body });
  assert.equal(closed, true);
});

test("native approval notification failure preserves the committed body and never reapplies", async () => {
  const params = { subsystem: "skills", id: "native-pending", expectedHash: "reviewed-hash" };
  const body = { ok: true, result: { success: true, committed: true, kept_pending: false,
    pendingId: params.id, payloadHash: params.expectedHash, nativeReceipt: "unchanged-original-receipt" } };

  for (const failure of ["notification", "observation"]) {
    const h = fixture(JSON.stringify(params));
    let applies = 0, observed = 0, closed = 0;
    const code = await handleSkillNative(h.ctx, { subsystem: "skill", nativeMethod: "pendingApply" }, () => ({
      compatibility: async () => {
        applies++;
        return body;
      }, close: () => { closed++; },
    }), async (received, input) => {
      observed++;
      assert.equal(received, h.ctx);
      assert.deepEqual(input, { pendingId: params.id, expectedHash: params.expectedHash, reply: body, at: "1970-01-01T00:00:00.000Z" });
      if (failure === "observation") throw new Error("original_observation_unavailable");
      return { ok: false, reason: "runtime_stopping" };
    });

    assert.equal(code, 0);
    assert.equal(applies, 1);
    assert.equal(observed, 1);
    assert.equal(closed, 1);
    assert.deepEqual(JSON.parse(h.out[0]!), { schemaVersion: 1, subsystem: "skill", method: "pendingApply", body });
    assert.deepEqual(h.warnings, [failure === "notification" ? "warning: central_runtime_skill_approval_notification_unavailable\n"
      : "warning: hermes_skill_lifecycle_observation_unavailable\n"]);
  }
});

test("invalid native input never starts a backend and private transport failures use fixed diagnostics", async () => {
  const bad = fixture("[]");
  let started = false;

  assert.equal(await handleSkillNative(bad.ctx, { subsystem: "skill", nativeMethod: "pendingList" }, () => {
    started = true;
    throw new Error("private");
  }), 2);
  assert.equal(started, false);

  for (const input of [{ subsystem: "memory", id: "memory-item", expectedHash: "hash" }, { subsystem: "skills", id: "skill-item" }]) {
    const rejected = fixture(JSON.stringify(input));
    assert.equal(await handleSkillNative(rejected.ctx, { subsystem: "skill", nativeMethod: "pendingApply" }, () => {
      started = true;
      throw new Error("should not start");
    }), 2);
    assert.equal(started, false);
  }

  const h = fixture("{}");

  assert.notEqual(await handleSkillNative(h.ctx, { subsystem: "skill", nativeMethod: "pendingList" }, () => { throw new Error("credential=private"); }), 0);
  assert.equal(h.out.join("").includes("credential=private"), false);
});
