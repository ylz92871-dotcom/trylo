import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createBoardReader, createFileBoardStore, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { normalizeBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { MAX_TOOL_USES, type ToolUseRecord } from "../../learning/domains/tool/evolution/use.js";
import type { CandidateExecutor } from "../../learning/domains/tool/evolution/execution.js";
import type { ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
import type { ToolPort } from "../../ports/tools.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { createAllowToolsPermission, createDenyAllPermission } from "../../surface/cli/permission.js";
import { wirePorts } from "../../surface/cli/wiring.js";
import { runTurn } from "../../loop/runner.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { prepareToolImprovement } from "./evolution-trials.js";
import { openToolCandidateUse, readToolCandidateUses, withdrawToolCandidate } from "./evolution-use.js";

async function seed(t: TestContext) {
  const base = path.resolve("Temp/tool-use-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact: ToolEvolutionArtifact = {
    schemaVersion: 1, generatedAt: new Date(0).toISOString(),
    candidate: { identity: "double", description: "Double a number", source: "module.exports = input => input * 2", inputSchema: { type: "number" },
      mastery: { whenToUse: ["Double finite numbers"], preconditions: [], pitfalls: [] } },
    request: { schemaVersion: 1, requestId: "seed", scope: "test", capability: "double", operation: "create", evidence: [
      { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
      { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
      { sampleId: "v", role: "variation", input: -1, expected: { kind: "value", value: -2 } },
      { sampleId: "e", role: "counterexample", input: "bad", expected: { kind: "error", code: "invalid_input" } },
    ] }, verification: { verdict: "pass", candidateHash: "", samplesHash: "", checks: [] },
  };
  // TEST ONLY: seed archived input; this is not process/model validation evidence.
  const verification = { verdict: "pass" as const, candidateHash: contentHashOf(artifact.candidate), samplesHash: contentHashOf(artifact.request.evidence),
    checks: artifact.request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY" })) };
  const saved = await createToolEvolutionArchive(root).save({ ...artifact, verification }); assert.ok(saved.ok);
  let ids = 0, executions = 0;
  const warnings: string[] = [];
  const options = { boardRoot: root, versionId: saved.versionId, sessionId: "test-session", workspaceId: "workspace-test", now: () => 0,
    newId: () => `use-${++ids}`, warn: (text: string) => { warnings.push(text); },
    executor: { execute: async (_candidate, input) => { executions += 1; return { kind: "value", value: typeof input === "number" ? input * 2 : null }; } } as CandidateExecutor };
  return { root, saved, options, warnings, count: () => executions, artifact };
}

test("additional candidate tool appears in the ordinary provider request and its result continues the same loop", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok);
  t.after(opened.mount.close);
  const name = opened.mount.binding.name;
  const input = { providerId: "fixture", model: "test", endpoint: "", apiKey: undefined, workspaceRoot: fx.root,
    permission: createAllowToolsPermission(new Set([name])), additionalTools: opened.mount.tools };
  const wiring = wirePorts(input); assert.ok(!("code" in wiring)); t.after(wiring.close);
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      assert.equal(request.tools.some(binding => binding.name === name), true);
      yield { type: "tool_call", toolCallId: "call-double", name, arguments: { input: 7 } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      assert.match(JSON.stringify(request.messages), /14/);
      yield { type: "text_delta", blockId: "answer", text: "The result is 14" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const result = await runTurn({ ...wiring.ports, provider }, { sessionId: "s", turnId: "t", correlationId: "c", text: "double 7" });
  assert.equal(requests.length, 2, JSON.stringify(result.envelopes)); assert.equal(fx.count(), 1);
  const uses = await readToolCandidateUses(fx.root, fx.saved.versionId); assert.ok(uses.ok);
  assert.equal(uses.records.length, 1); assert.equal(uses.records[0]?.quality, "unverified");
});

test("ordinary permission denial creates no candidate execution or use fact", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  const wiring = wirePorts({ providerId: "fixture", model: "test", endpoint: "", apiKey: undefined, workspaceRoot: fx.root,
    permission: createDenyAllPermission(), additionalTools: opened.mount.tools }); assert.ok(!("code" in wiring)); t.after(wiring.close);
  let requests = 0;
  const provider: ProviderPort = { async *stream() {
    if (++requests === 1) { yield { type: "tool_call", toolCallId: "denied", name: opened.mount.binding.name, arguments: { input: 9 } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true }; }
    else { yield { type: "text_delta", blockId: "answer", text: "denied" }; yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; }
  } };
  await runTurn({ ...wiring.ports, provider }, { sessionId: "s", turnId: "t", correlationId: "c", text: "double 9" });
  assert.equal(fx.count(), 0);
  const history = await readToolCandidateUses(fx.root, fx.saved.versionId); assert.ok(history.ok); assert.equal(history.records.length, 0);
});

test("duplicate call IDs cannot re-execute or change input; returned values are unverified facts", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  const call = { toolCallId: "same", name: opened.mount.binding.name, arguments: { input: 3 } };
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([opened.mount.tools.execute(call, signal), opened.mount.tools.execute(call, signal)]);
  assert.deepEqual(a, b); assert.equal(fx.count(), 1);
  assert.equal((await opened.mount.tools.execute({ ...call, arguments: { input: 4 } }, signal)).outcome, "error");
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(loaded.state.toolUses?.[0]?.inputHash, sha256Hex(canonicalJson(3)));
  assert.equal(loaded.state.toolUses?.[0]?.outputHash, sha256Hex(canonicalJson(6)));
  assert.equal(loaded.state.evidence.length, 0); assert.equal(loaded.state.toolTrials?.length ?? 0, 0); assert.equal(loaded.state.activations.length, 0);
});

test("withdrawing a mounted candidate prevents its next invocation", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  const retired = await withdrawToolCandidate(fx.root, fx.saved.versionId, new Date(0).toISOString());
  assert.ok(retired.ok);
  const repeated = await withdrawToolCandidate(fx.root, fx.saved.versionId, new Date(1).toISOString()); assert.ok(repeated.ok); assert.equal(repeated.changed, false);
  const result = await opened.mount.tools.execute({ toolCallId: "after-retire", name: opened.mount.binding.name, arguments: { input: 5 } }, new AbortController().signal);
  assert.equal(result.outcome, "error"); assert.equal(fx.count(), 0);
});

test("a Board write conflict reports missing use persistence without losing the known tool result", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  const owner = createFileBoardStore(fx.root); assert.ok("apply" in owner); t.after(() => owner.close());
  const result = await opened.mount.tools.execute({ toolCallId: "write-conflict", name: opened.mount.binding.name, arguments: { input: 11 } }, new AbortController().signal);
  assert.equal(result.outcome, "result");
  if (result.outcome === "result") { assert.equal(result.value.result, 22); assert.equal(result.value.useRecording, "unavailable"); }
  assert.equal(fx.warnings.length, 1);
});

test("closing a task aborts its running candidate and removes the borrowed table", async t => {
  const fx = await seed(t);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const executor: CandidateExecutor = { execute: async (_candidate, _input, signal) => {
    entered(); return new Promise(resolve => { signal.addEventListener("abort", () => { resolve({ kind: "cancelled" }); }, { once: true }); });
  } };
  const opened = await openToolCandidateUse({ ...fx.options, executor }); assert.ok(opened.ok);
  const pending = opened.mount.tools.execute({ toolCallId: "running", name: opened.mount.binding.name, arguments: { input: 5 } }, new AbortController().signal);
  await started; await opened.mount.close(); assert.equal((await pending).outcome, "cancelled");
  assert.deepEqual(opened.mount.tools.snapshot(), []);
  const history = await readToolCandidateUses(fx.root, fx.saved.versionId); assert.ok(history.ok);
  assert.equal(history.records[0]?.execution, "cancelled"); assert.equal(history.records[0]?.quality, "unverified");
});

test("extra tools coexist with MCP routing and respect tool selection and name collision checks", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  let mcpCalls = 0;
  const mcp: ToolPort = { snapshot: () => [{ ...opened.mount.binding, name: "mcp__test__echo" }], execute: async () => {
    mcpCalls++; return { outcome: "result", value: {}, output: "mcp", truncated: false }; }, cancel: async () => {} };
  const input = { providerId: "fixture", model: "test", endpoint: "", apiKey: undefined, workspaceRoot: fx.root, permission: createDenyAllPermission(),
    mcp: { tools: mcp, toolNames: new Set(["mcp__test__echo"]) }, additionalTools: opened.mount.tools };
  const wiring = wirePorts(input); assert.ok(!("code" in wiring)); t.after(wiring.close);
  assert.equal((await wiring.ports.tools.execute({ toolCallId: "mcp", name: "mcp__test__echo", arguments: {} }, new AbortController().signal)).outcome, "result");
  assert.equal(mcpCalls, 1); assert.equal(fx.count(), 0);
  const selected = wirePorts({ ...input, toolSelection: ["read_file"] }); assert.ok(!("code" in selected)); t.after(selected.close);
  assert.equal(selected.ports.tools.snapshot().some(item => item.name === opened.mount.binding.name), false);
  const collision = wirePorts({ ...input, additionalTools: mcp }); assert.ok("code" in collision); assert.equal(collision.code, "tool_name_conflict");
  const { additionalTools: _extra, ...base } = input;
  const ordinary = wirePorts({ ...base, permission: createAllowToolsPermission(new Set([opened.mount.binding.name])) });
  assert.ok(!("code" in ordinary)); t.after(ordinary.close);
  assert.equal(ordinary.ports.tools.snapshot().some(item => item.name.startsWith("learned__")), false);
  assert.equal(ordinary.ports.sandbox?.evaluate({ toolCallId: "hallucinated", name: opened.mount.binding.name, arguments: { input: 7 } }).ok, false);
});

test("runtime failure feedback can inform improvement without declaring task quality or revealing input", async t => {
  const fx = await seed(t);
  const opened = await openToolCandidateUse({ ...fx.options, executor: { execute: async () => ({ kind: "tool_error", code: "invalid_input" }) } });
  assert.ok(opened.ok); t.after(opened.mount.close);
  const result = await opened.mount.tools.execute({ toolCallId: "bad-interface", name: opened.mount.binding.name,
    arguments: { input: "PRIVATE_TEST_INPUT_DO_NOT_PERSIST" } }, new AbortController().signal);
  assert.equal(result.outcome, "error");
  const prepared = await prepareToolImprovement(fx.root, fx.saved.versionId, fx.artifact.request); assert.ok(prepared.ok);
  assert.match(prepared.feedback ?? "", /tool_error/); assert.match(prepared.feedback ?? "", /unverified/);
  const history = await readToolCandidateUses(fx.root, fx.saved.versionId); assert.ok(history.ok);
  assert.doesNotMatch(JSON.stringify(history.records) + prepared.feedback, /PRIVATE_TEST_INPUT_DO_NOT_PERSIST/);
});

test("use records survive compaction and reject false quality, identity conflicts, and capacity overflow", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  await opened.mount.tools.execute({ toolCallId: "fact", name: opened.mount.binding.name, arguments: { input: 4 } }, new AbortController().signal);
  const compacted = await withBoardWriter(fx.root, async store => { const loaded = await store.load(); assert.ok(loaded.ok); return store.compact(loaded.generation); }); assert.ok(compacted.ok);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  const record = loaded.state.toolUses?.[0]; assert.ok(record);
  const { toolUses: _uses, ...old } = loaded.state; assert.deepEqual(normalizeBoardState(old)?.toolUses, []);
  assert.equal(normalizeBoardState({ ...loaded.state, toolUses: [{ ...record, quality: "verified" } as unknown as ToolUseRecord] }), undefined);
  const command = { type: "record_tool_use" as const, commandId: "another", issuedAt: record.occurredAt, record };
  assert.ok(!reduce(loaded.state, { ...command, record: { ...record, inputHash: "0".repeat(64) } }).ok);
  const bad = reduce({ ...loaded.state, toolUses: [] }, { ...command, record: { ...record, contentHash: "0".repeat(64) } }); assert.ok(!bad.ok);
  assert.equal(bad.reason, "invalid_tool_use");
  const full = { ...loaded.state, toolUses: Array.from({ length: MAX_TOOL_USES }, (_, i) => ({ ...record, useId: `id-${i}` })) };
  const capped = reduce(full, command); assert.ok(!capped.ok); assert.equal(capped.reason, "tool_use_capacity");
});
