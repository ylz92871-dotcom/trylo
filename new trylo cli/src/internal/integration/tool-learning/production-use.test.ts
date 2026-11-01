import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { seedToolProduction, productionTestTime } from "../testing/tool-production-fixtures.js";
import { activateToolProduction, reviewToolProductionActivation, stopToolProduction } from "../../surface/cli/tool-production-activation.js";
import { openToolProductionUse, openWorkspaceProductionTools } from "./production-use.js";
import { createDenyAllPermission } from "../../surface/cli/permission.js";
import { wirePorts } from "../../surface/cli/wiring.js";
import { selectToolPort } from "../../surface/cli/tool-selection.js";

async function activeFixture(t: TestContext) {
  const fx = await seedToolProduction(t); await fx.admit();
  const review = await reviewToolProductionActivation(fx.selection); assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const issued = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: fx.selection.versionId, scope: toolProductionScope(fx.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" }); assert.ok(issued.ok);
  assert.ok((await activateToolProduction({ ...fx.selection, reviewId: review.reviewId, permission, token: { grantId: issued.grant.grantId }, issuedAt: productionTestTime })).ok);
  let calls = 0, ids = 0;
  const options = { ...fx.selection, sessionId: "task-one", now: () => 0, newId: () => `test-use-${++ids}`, warn: () => {},
    executor: { execute: async (_candidate: typeof fx.plan.candidate, input: unknown) => { calls++; return { kind: "value" as const, value: typeof input === "number" ? input * 2 : null }; } } };
  return { ...fx, options, count: () => calls };
}

test("approved tools mount by workspace and reopen for a later task with immutable version use facts", async t => {
  const fx = await activeFixture(t), first = await openWorkspaceProductionTools(fx.options); assert.ok(first.ok);
  assert.equal(first.tools.snapshot().length, 1); const name = first.tools.snapshot()[0]!.name;
  const signal = new AbortController().signal;
  assert.equal((await first.tools.execute({ toolCallId: "one", name, arguments: { input: 7 } }, signal)).outcome, "result");
  await first.close();
  const second = await openWorkspaceProductionTools({ ...fx.options, sessionId: "task-two" }); assert.ok(second.ok); t.after(second.close);
  assert.equal(second.tools.snapshot()[0]?.name, name);
  assert.equal((await second.tools.execute({ toolCallId: "two", name, arguments: { input: 8 } }, signal)).outcome, "result");
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok); assert.equal(loaded.state.toolUses?.length, 2);
  assert.deepEqual(loaded.state.toolUses?.map(item => item.sessionId), ["task-one", "task-two"]);
  assert.ok(loaded.state.toolUses?.every(item => item.versionId === fx.selection.versionId && item.quality === "unverified"));
  const foreign = await openWorkspaceProductionTools({ ...fx.options, workspaceId: "foreign" }); assert.ok(foreign.ok); t.after(foreign.close); assert.deepEqual(foreign.tools.snapshot(), []);
});

test("withdrawal refuses a mounted version including cached call replay and new task inventory", async t => {
  const fx = await activeFixture(t), opened = await openToolProductionUse(fx.options); assert.ok(opened.ok); t.after(opened.mount.close);
  const call = { toolCallId: "same", name: opened.mount.binding.name, arguments: { input: 2 } }, signal = new AbortController().signal;
  assert.equal((await opened.mount.tools.execute(call, signal)).outcome, "result");
  assert.ok((await stopToolProduction({ ...fx.selection, action: "withdraw", commandId: "withdraw", issuedAt: productionTestTime })).ok);
  assert.equal((await opened.mount.tools.execute(call, signal)).outcome, "error"); assert.equal(fx.count(), 1);
  const later = await openWorkspaceProductionTools(fx.options); assert.ok(later.ok); t.after(later.close); assert.deepEqual(later.tools.snapshot(), []);
});

test("withdrawal while executing discards a late value and records the failed authority boundary", async t => {
  const fx = await activeFixture(t); let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), ending = new Promise<void>(resolve => { finish = resolve; });
  const opened = await openToolProductionUse({ ...fx.options, executor: { execute: async () => { entered(); await ending; return { kind: "value", value: 14 }; } } }); assert.ok(opened.ok); t.after(opened.mount.close);
  const pending = opened.mount.tools.execute({ toolCallId: "late", name: opened.mount.binding.name, arguments: { input: 7 } }, new AbortController().signal);
  await started; assert.ok((await stopToolProduction({ ...fx.selection, action: "withdraw", commandId: "withdraw-running", issuedAt: productionTestTime })).ok);
  finish(); assert.equal((await pending).outcome, "error");
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok); assert.equal(loaded.state.toolUses?.[0]?.execution, "unavailable");
  assert.equal(loaded.state.toolUses?.[0]?.outputHash, undefined);
});

test("selection and ordinary permission denial cannot reach the production executor", async t => {
  const fx = await activeFixture(t), opened = await openWorkspaceProductionTools(fx.options); assert.ok(opened.ok); t.after(opened.close);
  const binding = opened.tools.snapshot()[0]!;
  assert.deepEqual(selectToolPort(opened.tools, []).snapshot(), []);
  const denied = await selectToolPort(opened.tools, []).execute({ toolCallId: "hidden", name: binding.name, arguments: { input: 1 } }, new AbortController().signal); assert.equal(denied.outcome, "unknown");
  const wiring = wirePorts({ providerId: "fixture", model: "test", endpoint: "", apiKey: undefined, workspaceRoot: fx.root, additionalTools: opened.tools,
    permission: { ...createDenyAllPermission(), isDenied: name => name === binding.name } }); assert.ok(!("code" in wiring)); t.after(wiring.close);
  const result = await wiring.ports.tools.execute({ toolCallId: "denied", name: binding.name, arguments: { input: 1 } }, new AbortController().signal);
  assert.equal(result.outcome, "error"); if (result.outcome === "error") assert.equal(result.code, "permission_denied");
  assert.equal(fx.count(), 0);
});
