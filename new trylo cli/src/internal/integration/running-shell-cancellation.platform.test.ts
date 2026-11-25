import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { createMutatingTools } from "../adapters/tools/mutating/index.js";
import { createWorkspaceSandbox } from "../adapters/sandbox/index.js";
import { createNdjsonSessionStore } from "../adapters/session-store/ndjson.js";
import { SESSION_FORMAT_VERSION } from "../ports/session.js";
import { testScratchPath } from "../testing/scratch.js";
import { createTurnRecorder } from "../surface/cli/turn-recorder.js";
import { createFakePermission, createFakeProvider, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

test("interrupting a real shell stops its process and permits the next turn in the same durable session", { timeout: 20000 }, async () => {
  const root = mkdtempSync(testScratchPath("live-shell-cancel-"));
  const marker = join(root, "child.pid");
  let childPid: number | undefined;
  let ready = (): void => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  const watcher = watch(root, () => {
    if (!existsSync(marker)) return;
    const pid = Number(readFileSync(marker, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) { childPid = pid; ready(); }
  });
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
  const path = join(root, "session.ndjson");
  const session = createNdjsonSessionStore({ path });
  const fingerprint = { schemaVersion: SESSION_FORMAT_VERSION, workspaceId: "w", providerId: "fake", model: "fake", toolCatalogHash: "h" };
  assert.equal((await session.start({ sessionId: "s", fingerprint, createdAt: "1970-01-01T00:00:00.000Z" })).ok, true);
  const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
  assert.ok(recorder);
  await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
  const controller = new AbortController();
  const command = 'node -e "require(\'node:fs\').writeFileSync(\'child.pid\',String(process.pid));setInterval(()=>{},1000)"';
  const running = runTurn({ tools, profile: emptyProfileLoader(), permission: createFakePermission("approved"), progress: recorder.progress,
    provider: createFakeProvider([[
      { type: "tool_call", toolCallId: "shell", name: "run_shell", arguments: { command } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ]]),
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "run then interrupt", cancelSignal: controller.signal });
  try {
    await Promise.race([started, running.then(result => { throw new Error(`shell ended before starting: ${JSON.stringify(result.transcript)}`); })]);
    controller.abort();
    const result = await running;
    assert.equal(result.state.terminalReason, "cancelled");
    assert.ok(childPid);
    assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
    await session.release();
    const resumed = createNdjsonSessionStore({ path });
    try {
      assert.equal((await resumed.attach()).ok, true);
      const read = await resumed.read();
      assert.ok(read.ok);
      assert.deepEqual(read.session.reconcileRequired, []);
      const next = await runTurn({ tools, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
        provider: createFakeProvider([[{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]]),
      }, { sessionId: "s", turnId: "next", correlationId: "next", text: "continue", resumedTranscript: read.session.transcript });
      assert.equal(next.state.terminalReason, "completed");
    } finally { await resumed.release(); }
  } finally {
    watcher.close();
    controller.abort();
    await tools.cancel("shell");
    await session.release();
  }
});
