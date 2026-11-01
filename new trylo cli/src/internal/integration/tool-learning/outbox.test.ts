import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFileToolLedger, TOOL_LEDGER_FILE, type ToolLedgerRecord } from "./ledger-file.js";
import { createToolGapRuntime } from "./awareness-runtime.js";
import { createToolGapRuntimeFor } from "../../surface/cli/tool-learning-config.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { handoffPendingToolPlans } from "./outbox-handoff.js";
import { ToolOutboxError, TOOL_LEDGER_MAX_BYTES } from "./outbox-reader.js";
import type { ToolLearningPlan } from "../../learning/domains/tool/evolution/pipeline.js";

const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "workspace:test", capability: "double", createdAt: new Date(0).toISOString(),
  trigger: { runId: "run", proposalKey: "double-gap", action: "replace_or_add", evidenceRefs: ["fact:1"] } };
const proposal = (value = plan): ToolLedgerRecord => ({ kind: "proposal", at: value.createdAt, turnId: value.trigger.runId,
  key: value.trigger.proposalKey, action: value.trigger.action, capability: value.capability, reason: "TEST ONLY accepted intent", pipelinePlan: value });
async function fixture(t: TestContext) {
  const base = path.resolve("Temp/tool-outbox-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerRoot = path.join(root, "learning/tool"), file = path.join(ledgerRoot, TOOL_LEDGER_FILE), ledger = createFileToolLedger(ledgerRoot);
  const boardRoot = path.join(root, "learning/board"), warnings: string[] = [];
  const host = { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: plan.scope, now: () => 0, warn: (message: string) => { warnings.push(message); } };
  const state = async () => { const loaded = await createBoardReader(boardRoot).load(); assert.ok(loaded.ok); return loaded.state; };
  return { root, file, ledgerRoot, ledger, boardRoot, host, state, warnings };
}

test("accepted intent survives process loss before Board handoff and is replayed once", async t => {
  const fx = await fixture(t), interrupted = createToolGapRuntimeFor(fx.host);
  await interrupted.port.observe({ turnId: "lost-turn", beat: 1, toolNames: ["run_shell"],
    failures: Array.from({ length: 3 }, () => ({ tool: "run_shell", code: "tool_error", fingerprint: "fp" })),
    selfReport: JSON.stringify({ need: "改进:double", tool: "run_shell" }) });
  assert.equal(interrupted.proposals().length, 1); assert.equal((await fx.state()).jobs.length, 0);
  await createToolGapRuntimeFor(fx.host).close(); const state = await fx.state(); assert.equal(state.jobs.length, 1);
  assert.equal((await fx.ledger.pendingPlans()).length, 0);
  await createToolGapRuntimeFor(fx.host).close(); assert.equal((await fx.state()).sequence, state.sequence);
});

test("unavailable Board preserves the handoff for a later run instead of requiring another gap", async t => {
  const fx = await fixture(t); await fx.ledger.append(proposal());
  await writeFile(fx.boardRoot, "TEST ONLY original blocker");
  await createToolGapRuntimeFor(fx.host).close(); assert.equal((await fx.ledger.pendingPlans()).length, 1);
  await rename(fx.boardRoot, `${fx.boardRoot}.blocked`);
  await createToolGapRuntimeFor(fx.host).close(); assert.equal((await fx.state()).jobs.length, 1);
  assert.equal(await readFile(`${fx.boardRoot}.blocked`, "utf8"), "TEST ONLY original blocker");
});

test("lost handoff acknowledgement does not invalidate or duplicate the authoritative Board job", async t => {
  const fx = await fixture(t); await fx.ledger.append(proposal());
  const input = { ledger: { ...fx.ledger, append: async (record: ToolLedgerRecord) => {
    if (record.kind === "pipeline_handoff") throw new Error("TEST ONLY lost acknowledgement");
    await fx.ledger.append(record);
  } }, boardRoot: fx.boardRoot, scope: plan.scope, now: () => 0, warn: fx.host.warn };
  const accepted = await handoffPendingToolPlans(input); assert.equal(accepted.length, 1);
  const sequence = (await fx.state()).sequence; assert.equal((await fx.ledger.pendingPlans()).length, 1);
  await handoffPendingToolPlans({ ...input, ledger: fx.ledger });
  assert.equal((await fx.state()).sequence, sequence); assert.equal((await fx.ledger.pendingPlans()).length, 0);
});

test("handoff recovery never crosses the active workspace", async t => {
  const fx = await fixture(t); await fx.ledger.append(proposal());
  const other = { ...plan, scope: "other-workspace", trigger: { ...plan.trigger, proposalKey: "other-gap" } }; await fx.ledger.append(proposal(other));
  await createToolGapRuntimeFor(fx.host).close(); assert.equal((await fx.state()).jobs.length, 1);
  assert.equal((await fx.ledger.pendingPlans())[0]?.scope, other.scope);
  await createToolGapRuntimeFor({ ...fx.host, workspaceId: other.scope }).close(); assert.equal((await fx.state()).jobs.length, 2);
});

test("frequency history does not disappear behind 500 unrelated observations", async t => {
  const fx = await fixture(t); await mkdir(fx.ledgerRoot, { recursive: true });
  const records: ToolLedgerRecord[] = Array.from({ length: 3 }, (_, index) => ({ kind: "proposal", at: plan.createdAt, turnId: `run-${index}`,
    key: `different-${index}`, action: "replace_or_add", capability: "capability", reason: "TEST ONLY history" }));
  for (let index = 0; index < 501; index++) records.push({ kind: "observation", at: plan.createdAt, turnId: `observation-${index}`, reason: "no_self_report", detail: "TEST ONLY" });
  await writeFile(fx.file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  assert.equal((await fx.ledger.tail()).length, 500); assert.equal((await fx.ledger.history?.())?.length, 3);
  const runtime = createToolGapRuntime({ ledger: fx.ledger, now: () => 0, warn: fx.host.warn });
  await runtime.port.observe({ turnId: "new-run", beat: 1, toolNames: ["tool-four"], failures: Array.from({ length: 3 }, () => ({ tool: "tool-four", code: "tool_error", fingerprint: "fp" })),
    selfReport: JSON.stringify({ need: "改进:fourth capability", tool: "tool-four" }) });
  assert.equal(runtime.proposals().length, 0); assert.equal((await fx.ledger.tail()).at(-1)?.kind, "throttled");
});

test("corrupt admission history is retained and disables collection without failing execution", async t => {
  const fx = await fixture(t); await mkdir(fx.ledgerRoot, { recursive: true }); const original = "{invalid-json}\n"; await writeFile(fx.file, original);
  await assert.rejects(() => fx.ledger.tail(), ToolOutboxError);
  const runtime = createToolGapRuntime({ ledger: fx.ledger, now: () => 0, warn: fx.host.warn });
  for (const turnId of ["one", "two"]) await runtime.port.observe({ turnId, beat: 1, toolNames: ["run_shell"],
    failures: Array.from({ length: 3 }, () => ({ tool: "run_shell", code: "tool_error", fingerprint: "fp" })), selfReport: JSON.stringify({ need: "改进:double", tool: "run_shell" }) });
  assert.equal(runtime.proposals().length, 0); assert.equal(fx.warnings.length, 1); assert.equal(runtime.port.intentOn("one", 2), false);
  assert.equal(await readFile(fx.file, "utf8"), original);
});

test("unframed, oversized, or mismatched outbox records fail closed", async t => {
  const fx = await fixture(t); await mkdir(fx.ledgerRoot, { recursive: true });
  for (const raw of [JSON.stringify(proposal()), JSON.stringify({ ...proposal(), key: "mismatched-key" }) + "\n"]) {
    await writeFile(fx.file, raw); await assert.rejects(() => fx.ledger.pendingPlans(), ToolOutboxError); assert.equal(await readFile(fx.file, "utf8"), raw);
  }
  await writeFile(fx.file, Buffer.alloc(TOOL_LEDGER_MAX_BYTES + 1, 32));
  await assert.rejects(() => fx.ledger.pendingPlans(), error => error instanceof ToolOutboxError && error.code === "tool_outbox_too_large");
});
