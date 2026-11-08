import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import type { CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeWork } from "../../learning/central/runtime/contracts.js";
import { createCentralRuntimeStore } from "../../integration/central-learning/runtime-store.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { readCentralRuntimeOverviewFor } from "./central-runtime-overview.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./workspace-identity.js";
import { handleCentralLearning } from "./commands-central-learning.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

const object = (value: unknown): JsonObject => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 5000 };

test("on-demand overview distinguishes missing and invalid checkpoints and reads a bounded public head without starting or writing learning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-overview-")), home = path.join(root, "profile"), scope = path.join(root, "workspace");

  mkdirSync(home);
  mkdirSync(scope);
  const owned = createProcessContext();
  let output = "";
  const ctx = { ...owned, cwd: scope, homeDir: root, env: { TRYLO_HOME: home }, stdout(value: string) { output += value; }, stderr() {} };
  const paths = runtimeScopePaths(home, scope), boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);

  try {
    assert.equal((await readCentralRuntimeOverviewFor(ctx, scope)).status, "not_configured");
    assert.equal(existsSync(boardRoot), false);
    const lease = tryAcquireRuntimeOwner(paths);
    assert.ok(lease.ok);
    assert.ok(lease.value.writeIntent({ schemaVersion: 1, homeRoot: home, workspaceRoot: scope, enabled: false,
      configuration: { schemaVersion: 1, providerId: "fixture", model: "no-provider", endpointHash: contentHashOf(""),
        workspaceId: workspaceIdentity(scope), allowance, userLearning: true },
      wakeSequence: 0, consumedSequence: 0, wakeReason: "fixture", sourceRefs: [] }).ok);
    lease.value.close();
    const noHead = await readCentralRuntimeOverviewFor(ctx, scope);
    assert.equal(noHead.status, "no_checkpoint");
    assert.equal(Object.hasOwn(noHead, "headRef"), false);
    const store = createCentralRuntimeStore({ boardRoot, enabled: () => true }), initial = await store.read(scope);
    const intent = (id: string): CentralLearningIntentDraft => ({ intentId: id,
      subject: { plane: "agent", domain: "collaboration", issueId: `issue:${id}` },
      goal: `Investigate overview-secret-value at ${path.join(scope, "result.txt")}; ${"x".repeat(220)}`,
      rationale: "Original public research purpose", conditions: [], knowledge: [], residual: ["A", "B", "C", "D"],
      commitment: { purpose: "Resolve the original boundary", assumptions: [], reconsiderWhen: [] }, revisionReason: "Original source",
      sourceRefs: ["fact:1", "fact:2", "fact:3", "fact:4", "fact:5"], continuation: { kind: "waiting", wait: {
        kind: "facts", reason: "Await the original receiver evidence", sourceRefs: ["fact:original"] } } });
    const privateIntent: CentralLearningIntentDraft = { ...intent("private:intent"), subject: { plane: "user", ledgerRef: "PRIVATE_LEDGER", questionRef: "PRIVATE_QUESTION" },
      goal: "PRIVATE_USER_GOAL", residual: ["PRIVATE_USER_RESIDUAL"], sourceRefs: ["PRIVATE_USER_SOURCE"], continuation: { kind: "open" } };
    const dispatch: Extract<CentralLearningOperation, { kind: "dispatch" }> = { kind: "dispatch", operationId: "operation:public",
      destination: { plane: "agent", domain: "collaboration" }, purpose: "Original unresolved native research", expectedChange: "Inspect the original result",
      sourceRefs: ["fact:original"], allowance };
    const work: CentralRuntimeWork = { intentId: "intent:0", operation: dispatch, workRef: "work:original", frame: { kind: "native", private: "PRIVATE_FRAME" } };
    const privateWork: CentralRuntimeWork = { ...work, intentId: privateIntent.intentId, workRef: "PRIVATE_WORK",
      operation: { ...dispatch, operationId: "PRIVATE_OPERATION", destination: { plane: "user" } }, frame: { kind: "user_learning", secret: "PRIVATE_FRAME" } };
    const saved = await store.append({ previousRef: initial.stateRef, expectedRevision: initial.revision,
      state: { ...emptyCentralRuntimeState(scope), intents: [...Array.from({ length: 10 }, (_, index) => index === 0
        ? { ...intent(`intent:${index}`), continuation: { kind: "open" as const } } : intent(`intent:${index}`)), privateIntent],
        running: [work, privateWork] }, reason: "Controlled public overview checkpoint", sourceRefs: ["fact:original"] });
    assert.equal(saved.status, "written");
    const log = path.join(boardRoot, "board-events.ndjson"), before = sha256Hex(readFileSync(log, "utf8"));
    const view = await readCentralRuntimeOverviewFor(ctx, scope, { secrets: ["overview-secret-value"] });
    assert.equal(view.status, "ready", JSON.stringify(view));
    assert.equal(view.intentEnabled, false);
    assert.equal(view.headRef, (await store.read(scope)).stateRef);
    assert.ok(Array.isArray(view.intents));
    assert.equal(view.intents.length, 8);
    assert.equal(view.omittedIntents, 2);
    const first = object(view.intents[0]);
    assert.equal(first.omittedResiduals, 1);
    assert.equal(object(first.goal).truncated, true);
    assert.deepEqual(first.continuation, { kind: "open", interpretation: "open_purpose_without_committed_successor" });
    assert.equal(object(first.sources).omitted, 1);
    assert.equal(object(view.privateUser).active, 1);
    assert.equal(object(view.privateUser).open, 1);
    assert.equal(object(view.privateUser).ready, 0);
    assert.equal(object(view.privateUser).waiting, 0);
    assert.ok(Array.isArray(view.recordedWork));
    assert.equal(view.recordedWork.length, 1);
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|overview-secret-value/);
    assert.ok(JSON.stringify(view).includes("<workspace>"));
    const commandCtx = { ...ctx, readStdin: async () => JSON.stringify({ workspaceRoot: scope, action: "overview" }) };

    assert.equal(await handleCentralLearning(commandCtx, { subsystem: "central", centralOperation: "runtime" }), EXIT_CODES.OK);
    const wire = object(JSON.parse(output));
    assert.equal(wire.action, "overview");
    assert.equal(object(wire.learning).status, "ready");
    assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_/);
    assert.ok(!JSON.stringify(wire).includes(JSON.stringify(scope).slice(1, -1)), "the default CLI projection keeps absolute source paths out");
    assert.equal(sha256Hex(readFileSync(log, "utf8")), before);
    assert.equal(existsSync(paths.locatorPath), false);
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.equal(board.state.centralLearningBudgets?.length ?? 0, 0);
    writeFileSync(log, "invalid original log\n");
    const failed = await readCentralRuntimeOverviewFor(ctx, scope);
    assert.equal(failed.status, "unavailable");
    assert.equal(Object.hasOwn(failed, "intents"), false);
  } finally {
    owned.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-runtime-overview-/);
    rmSync(root, { recursive: true, force: true });
  }
});
