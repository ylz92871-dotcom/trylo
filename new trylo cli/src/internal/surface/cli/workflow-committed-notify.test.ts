import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import type { CliContext } from "./context.js";
import { handleWorkflowLearning } from "./commands-workflow-learning.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

test("standalone workflow learn commits its native version before waking only the existing enabled scope owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-committed-notify-")), homeRoot = path.join(root, "home");
  const workspaceRoot = path.join(root, "original-workspace"), requestPath = path.join(workspaceRoot, "request.json");
  const task = { scope: "repo:test-workflow", taskFamily: { id: "source-navigation", intentClass: "locate_owner", checkKind: "acceptance" } };
  const request = { ...task, subsystem: "workflow", requestId: "request:committed-notify", collect: true,
    budget: { maxEpisodes: 1, maxSteps: 2, maxTokens: 4096 }, traces: [{ ...task, schemaVersion: 1, traceId: "trace:imported-source", source: "imported",
      outcome: "success", steps: [{ nodeId: "inspect-owner", input: "current source index", output: "owning file", dependsOn: [],
        check: "owner is present", status: "passed", evidenceRefs: ["receipt:imported-source"] }] }] };
  const stdout: string[] = [], stderr: string[] = [];
  const ctx: CliContext = { env: { TRYLO_HOME: homeRoot }, homeDir: root, cwd: workspaceRoot, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: file => file === requestPath ? JSON.stringify(request) : undefined, isDirectory: () => true, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); }, now: () => Date.parse("2026-11-05T10:00:00.000Z"), newId: prefix => prefix };
  const paths = runtimeScopePaths(homeRoot, workspaceRoot), acquired = tryAcquireRuntimeOwner(paths,
    { ownerPid: 1234, createToken: () => "fixture-owner-lock", processStatus: () => "alive" });
  assert.ok(acquired.ok);
  const owner = acquired.value, requests: unknown[] = [];
  let committedAtWake = false;
  const locator = { schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: "fixture-existing-owner", pid: 1234, port: 1, token: "fixture-rpc-token" };
  const server = http.createServer((incoming, response) => {
    assert.equal(incoming.headers.authorization, `Bearer ${locator.token}`);
    let body = "";
    incoming.on("data", chunk => { body += String(chunk); });
    incoming.on("end", () => {
      void (async () => {
        const state = await createBoardReader(workflowBoardRoot(ctx)).load();
        assert.ok(state.ok);
        const envelope = JSON.parse(body);
        requests.push(envelope);
        committedAtWake = state.state.assets.some(asset => asset.versionId === envelope.wake.sourceRefs[0]);
        response.end(JSON.stringify({ ok: true, snapshot: { schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: locator.ownerId,
          revision: 1, wakeSequence: 1, consumedSequence: 0, state: "running" } }));
      })().catch(error => { response.destroy(error); });
    });
  });

  try {
    assert.ok(owner.writeIntent({ schemaVersion: 1, homeRoot, workspaceRoot, enabled: true, configuration: {},
      wakeSequence: 0, consumedSequence: 0, wakeReason: "fixture-initial", sourceRefs: [] }).ok);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.ok(owner.writeLocator({ ...locator, port: address.port }).ok);
    assert.equal(await handleWorkflowLearning(ctx, ["learn", "request.json"]), EXIT_CODES.OK);
    const saved = JSON.parse(stdout.join(""));
    assert.ok(saved.ok);
    assert.equal(saved.value.providerCalls, 0);
    assert.equal(committedAtWake, true);
    assert.deepEqual(stderr, []);
    assert.deepEqual(requests, [{ operation: "wake", wake: { reason: "workflow_learning_committed", sourceRefs: [saved.value.versionId] } }]);
  } finally {
    owner.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
