import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BOARD_SNAPSHOT_FILE, snapshotChecksum, snapshotState, snapshotVersion } from "../../adapters/learning-store/board-snapshot.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput, CentralLearningIntentDraft,
  CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { learningChangeBody, learningChangeEvents, readLearningChangeWire } from "./change-test-support.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { centralActionCorrectionOperationId, isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";

const AT = "2026-11-06T12:00:00.000Z", SOURCE = "source:capacity-original";
const H8_DIRECTORY = "D:/CC/trylo/_workspace/tasks/legacy-work/learning-runtime-20261105/sol-03-H8-observations/H8-original-scope--g0N0Cj";
const H8_OPERATION = "central-agenda-read-review:20502eded9778ec27499f4064ccbe8977232ae4d59acbfd9f2f7d7bb4423db12";
const H8_BOARD_SHA = "c58d6e82558337895b7c74e8e7c03ba9c9de67b33115985746bc47efbb7715b5";

type Outcome = "returned" | "length" | "unknown" | "action_rejection";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function temporaryBoard(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-capacity-increase-integration-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-capacity-increase-integration-/u);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(t: TestContext, settings: { actual: number; maximum: number; outcomes: readonly Outcome[];
  seed?: { readonly board: BoardState; readonly scope: string; readonly configuration: CentralLearningConfiguration } }) {
  const boardRoot = await temporaryBoard(t), enabled = () => true, now = () => AT;
  const scope = settings.seed?.scope ?? "workspace:capacity-increase-integration";

  if (settings.seed !== undefined) {
    const state = settings.seed.board;
    const snapshot = { ...snapshotVersion(state), generation: 0, sequence: state.sequence, checksum: "", state };
    await writeFile(path.join(boardRoot, BOARD_SNAPSHOT_FILE), JSON.stringify({ ...snapshot, checksum: snapshotChecksum(snapshot) }));
  }

  const policy = { defaultMaxOutputTokens: settings.actual, maxOutputTokens: settings.maximum };
  const configuration: CentralLearningConfiguration = settings.seed?.configuration ?? {
    schemaVersion: 1, configurationRef: "configuration:capacity-increase", generationRef: `generation:unchanged-${settings.actual}-${settings.maximum}`,
    authorizationRef: "authorization:capacity-increase", generationLimits: policy, thoughtMaxTokens: 250000,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000000, maxCalls: 64, maxSteps: 64, maxPromptChars: 100000 } };
  const ready = await ensureCentralLearningBudget({ boardRoot, scope, allowance: configuration.allowance,
    authorizationRef: configuration.authorizationRef, now, enabled, ...(configuration.rootRef === undefined ? {} : { rootRef: configuration.rootRef }) });

  assert.ok(ready.ok);
  const input: CentralLearningDriveInput = { scope, configuration: { ...configuration, rootRef: ready.rootRef },
    signal: new AbortController().signal, wake: { reason: "original_scope_resume", sourceRefs: settings.seed === undefined ? [SOURCE] : [] }, publish() {} };
  const store = createCentralRuntimeStore({ boardRoot, enabled });
  const source: CentralRuntimeSourcePort = { async snapshot() {
    const current = await store.read(scope);
    return { boardSequence: current.revision, opportunities: [], sourceRefs: settings.seed === undefined ? [SOURCE] : [],
      materials: settings.seed === undefined ? [{ ref: SOURCE, kind: "source" as const, text: "The original comparison is unresolved.", sourceRefs: [] }]
        : current.state.materials };
  }, async read() { throw new Error("This fake provider cannot read original files or profiles"); } };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consultation requested"); },
    async prepare() { throw new Error("No dispatch requested"); }, async execute() { throw new Error("No worker requested"); }, async recover() { return null; } };
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: ready.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: ready.rootRef.budgetId }, now, enabled });
  const wires: ProviderRequest[] = [], requests: CentralDeliberationRequest[] = [];

  async function* stream(wire: ProviderRequest): AsyncIterable<ProviderEvent> {
    wires.push(wire);
    const outcome = settings.outcomes[wires.length - 1];

    assert.ok(outcome, "a quiet/cold recovery must not purchase an unplanned extra computation");

    if (outcome === "returned") {
      const view = readLearningChangeWire(wire);
      yield* learningChangeEvents({ checkpoint: view.checkpoint, changes: [], explanation: "Retain the unresolved original question without inventing a result.", sources: [] });
      return;
    }

    if (outcome === "action_rejection") {
      const view = readLearningChangeWire(wire);
      const body = learningChangeBody(view, "The original comparison is unresolved.");

      // A real supplied source handle is not a read capability. The ordinary
      // compiler must emit the typed /inspect/refs/0 kind-mismatch refusal.
      yield* learningChangeEvents({ checkpoint: view.checkpoint, changes: [], explanation: "Attempt an original inspection using the wrong supplied capability kind.",
        inspect: { purpose: "Inspect the original comparison", expectedChange: "Resolve the original uncertainty", refs: [body.handle], maximumChars: 1000 }, sources: [] });

      return;
    }

    yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };

    if (outcome === "length") yield { type: "usage", usage: { mode: "snapshot", inputTokens: 90, outputTokens: wire.maxOutputTokens!,
      totalTokens: 90 + wire.maxOutputTokens!, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  }

  const provider: ProviderPort = { stream, fork: () => ({ stream }) };
  const makeDriver = () => {
    const model = createCentralModelDeliberation({ provider, model: "fake-capacity-no-network", funding, generationLimits: policy,
      outputMode: "tool", receipts: createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: ready.rootRef.budgetId, enabled }) });
    const inspect = model.inspect;
    assert.ok(inspect, "the fixture requires original receipt inspection");
    const deliberation = { async deliberate(request: CentralDeliberationRequest, signal: AbortSignal) {
      requests.push(request);
      return model.deliberate(request, signal);
    },

      inspect: inspect.bind(model) };
    return createCentralLearningDriver({ boardRoot, scope, enabled, now, source, execution, deliberation });
  };
  const board = async () => {
    const read = await createBoardReader(boardRoot).load();
    assert.ok(read.ok);
    return read.state;
  };

  return { input, wires, requests, store, funding, makeDriver, board, rootRef: ready.rootRef };
}

function assertQuote(wire: ProviderRequest, request: CentralDeliberationRequest, maximum: number) {
  assert.equal(wire.maxOutputTokens, maximum);
  assert.equal(request.operation.kind, "think");

  if (request.operation.kind === "think") assert.equal(request.operation.maxOutputTokens, maximum);

  assert.match(request.operation.operationId, /^central-output-capacity-increase:/u);
  const envelope = JSON.parse(wire.messages.at(-1)!.content);

  assert.equal(envelope.role, "host_original_root_after_this_computation_reservation");
  assert.equal(envelope.budgetId, request.budgetId);
  assert.equal(envelope.thisComputation.reservationId, wire.attemptId);
  assert.equal(envelope.thisComputation.calls, 1);
  assert.equal(envelope.thisComputation.steps, 1);
  assert.ok(envelope.thisComputation.maxTokens >= maximum, "the actual original quote must reserve the selected generation bound");
  assert.equal(envelope.available.tokens, envelope.limits.tokens - envelope.occupied.tokens);
}

test("complete length gets one larger quote under the same generation policy and cold recovery never repays the old call", async t => {
  for (const [actual, maximum] of [[8192, 16384], [32768, 65536]] as const) await t.test(`${actual} to ${maximum}`, async child => {
    const f = await fixture(child, { actual, maximum, outcomes: ["length", "returned"] }), first = f.makeDriver();
    const initial = await first.drive(f.input);
    assert.equal(f.wires.length, 1, canonicalJson(initial));
    assert.equal(initial.state, "ready", canonicalJson(initial));
    assert.equal(initial.reason, "central_output_capacity_increase_available");
    const original = f.requests[0]!;

    child.diagnostic(`first length: ${initial.state}/${initial.reason}; original requested cap ${f.wires[0]!.maxOutputTokens}`);
    const paid = await f.funding.inspect();
    assert.ok(paid.ok);
    const oldAccounting = canonicalJson(paid.projection.budget.accounting?.find(row => row.reservationId === f.wires[0]!.attemptId));

    await first.close?.();
    const cold = f.makeDriver();

    try {
      const recovered = await cold.drive(f.input);
      assert.equal(f.wires.length, 2,
        `the real driver must select one capacity increase rather than remain blocked: ${canonicalJson(recovered)}`);
      const request = f.requests[1]!;
      assertQuote(f.wires[1]!, request, maximum);
      child.diagnostic(`cold continuation actual wire maxOutputTokens=${f.wires[1]!.maxOutputTokens}`);
      assert.notEqual(request.operation.operationId, original.operation.operationId);
      assert.equal(request.configuration.generationRef, original.configuration.generationRef);
      await cold.drive(f.input);
      await cold.drive(f.input);
      assert.equal(f.wires.length, 2);
      const after = await f.funding.inspect();
      assert.ok(after.ok);
      assert.equal(canonicalJson(after.projection.budget.accounting?.find(row => row.reservationId === f.wires[0]!.attemptId)), oldAccounting);
      assert.equal(after.projection.budget.budgetId, f.rootRef.budgetId);
      assert.deepEqual(after.projection.budget.limits, paid.projection.budget.limits);
      const current = await f.store.read(f.input.scope);

      assert.equal(current.state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "failed");
    } finally { await cold.close?.(); }
  });
});

test("capacity blocker regression: another ready thought without fresh research cannot starve an authenticated capacity increase", async t => {
  const f = await fixture(t, { actual: 8192, maximum: 16384, outcomes: ["length", "returned"] });
  const driver = f.makeDriver();

  try {
    const refused = await driver.drive(f.input);

    assert.equal(refused.reason, "central_output_capacity_increase_available");
    assert.equal(f.wires.length, 1);
    const originalId = f.requests[0]!.operation.operationId, current = await f.store.read(f.input.scope);
    const otherOperation = { kind: "think" as const, operationId: "thought:other-ready-without-fresh-research",
      purpose: "Assess the same already pending original", expectedChange: "Choose a useful next comparison", sourceRefs: [SOURCE] };
    const other: CentralLearningIntentDraft = { intentId: "intent:ready-without-new-research",
      subject: { plane: "central", questionRef: "question:other-unresolved-comparison" },
      goal: "Retain another unfinished comparison", rationale: "The existing original material remains unresolved",
      conditions: [], knowledge: [], residual: ["The comparison still needs a decision"],
      commitment: { purpose: "Think about the existing material", assumptions: [], reconsiderWhen: [] },
      revisionReason: "Keep the already ready purpose", sourceRefs: [SOURCE],
      continuation: { kind: "ready", operation: otherOperation } };
    const appended = await f.store.append({ previousRef: current.stateRef, expectedRevision: current.revision,
      state: { ...current.state, intents: [other, ...current.state.intents] }, reason: "test_original_ready_purpose", sourceRefs: [SOURCE] });

    assert.equal(appended.status, "written");
    const resumed = await driver.drive(f.input);

    assert.equal(f.wires.length, 2, `a ready thought blocked by the original capacity wait must not hide its eligible increase: ${canonicalJson(resumed)}`);
    assertQuote(f.wires[1]!, f.requests[1]!, 16384);
    assert.equal(f.requests[1]!.operation.sourceRefs[0], originalId);
    assert.equal(f.requests.some(row => row.operation.operationId === otherOperation.operationId), false);
    const after = await f.store.read(f.input.scope);

    assert.equal(after.state.intents.find(row => row.intentId === other.intentId)?.continuation.kind, "ready");
  } finally { await driver.close?.(); }
});

test("capacity blocker regression: typed action refusals cannot extend a capacity continuation while ordinary action corrections may increase once", async t => {
  for (const cold of [false, true]) await t.test(cold ? "capacity refusal after cold recovery" : "capacity refusal in the same owner", async child => {
    // The third fake result is a trap: a forbidden correction is allowed to
    // reach the real quote/provider path so the test can count its payment.
    const f = await fixture(child, { actual: 8192, maximum: 16384, outcomes: ["length", "action_rejection", "returned"] });
    let driver = f.makeDriver();

    try {
      await driver.drive(f.input);
      const refusal = await driver.drive(f.input);

      assert.equal(f.wires.length, 2);
      const capacityId = f.requests[1]!.operation.operationId;

      assertQuote(f.wires[1]!, f.requests[1]!, 16384);
      const refused = await f.store.read(f.input.scope), block = refused.state.materials.map(row => {
        try { return JSON.parse(row.text); } catch { return undefined; }
      }).find(row => row?.operationId === capacityId && row.semanticRejection);

      assert.equal(block?.semanticRejection.field, "/inspect/refs/0");
      assert.equal(block?.semanticRejection.cause, "kind_mismatch");

      if (cold) {
        await driver.close?.();
        driver = f.makeDriver();
      }

      await driver.drive(f.input);
      await driver.drive(f.input);
      const final = await f.store.read(f.input.scope);
      const accounting = await f.funding.inspect();
      assert.ok(accounting.ok);
      const forbidden = centralActionCorrectionOperationId(f.input.scope, f.rootRef.budgetId, capacityId);

      assert.deepEqual({ immediateState: refusal.state, paidCalls: f.wires.length,
        occupiedRootCalls: accounting.projection.occupied.calls,
        correctionIssued: final.history.operations.some(row => row.operationId === forbidden) },
      { immediateState: "waiting", paidCalls: 2, occupiedRootCalls: 2, correctionIssued: false });
    } finally { await driver.close?.(); }
  });
  await t.test("an ordinary action correction with complete length keeps its one capacity continuation", async child => {
    const f = await fixture(child, { actual: 8192, maximum: 16384, outcomes: ["action_rejection", "length", "returned"] });
    const first = f.makeDriver();

    try {
      await first.drive(f.input);
      const correctionLength = await first.drive(f.input);

      assert.equal(f.wires.length, 2);
      const correction = f.requests[1]!;

      assert.equal(isCentralActionCorrectionOperation(f.input.scope, correction.operation), true);
      assert.equal(correctionLength.reason, "central_output_capacity_increase_available");
      assert.equal(correctionLength.state, "ready");
      await first.close?.();
      const resumed = f.makeDriver();

      try {
        const progress = await resumed.drive(f.input);
        assert.equal(f.wires.length, 3, canonicalJson(progress));
        assertQuote(f.wires[2]!, f.requests[2]!, 16384);
        assert.equal(f.requests[2]!.operation.sourceRefs[0], correction.operation.operationId);
        await resumed.drive(f.input);
        assert.equal(f.wires.length, 3);
      } finally { await resumed.close?.(); }
    } finally { await first.close?.(); }
  });
});

test("a second complete length or unknown result ends the one increase, while an unknown original never receives it", async t => {
  for (const next of ["length", "unknown"] as const) await t.test(`increased call ${next}`, async child => {
    const f = await fixture(child, { actual: 8192, maximum: 16384, outcomes: ["length", next] }), driver = f.makeDriver();
    const initial = await driver.drive(f.input);
    assert.equal(f.wires.length, 1, canonicalJson(initial));
    const recovered = await driver.drive(f.input);
    assert.equal(f.wires.length, 2, canonicalJson(recovered));
    assertQuote(f.wires[1]!, f.requests[1]!, 16384);
    await driver.close?.();
    const cold = f.makeDriver();
    try {
      await cold.drive(f.input);
      await cold.drive(f.input);
      assert.equal(f.wires.length, 2);
    }
    finally { await cold.close?.(); }
  });

  const f = await fixture(t, { actual: 8192, maximum: 16384, outcomes: ["unknown"] }), driver = f.makeDriver();
  const initial = await driver.drive(f.input);
  assert.equal(f.wires.length, 1, canonicalJson(initial));
  await driver.close?.();
  const cold = f.makeDriver();
  try {
    await cold.drive(f.input);
    await cold.drive(f.input);
    assert.equal(f.wires.length, 1);
    const current = await f.store.read(f.input.scope);
    assert.equal(current.state.completed[0]?.outcome, "unknown");
    const paid = await f.funding.inspect();
    assert.ok(paid.ok);
    assert.equal(paid.projection.budget.accounting?.[0]?.usage?.kind, "unknown");
  } finally { await cold.close?.(); }
});

test("the actual H8 final565 selection cannot let the old correction mask the eligible complete-length increase", async t => {
  const boardFile = path.join(H8_DIRECTORY, "final-board.json"), bytes = await readFile(boardFile);

  assert.equal(digest(bytes), H8_BOARD_SHA);
  const board: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(snapshotState(board));
  assert.equal(board.sequence, 565);
  const audit = JSON.parse(await readFile("D:/CC/trylo/_workspace/tasks/legacy-work/learning-runtime-20261105/sol-01-H8-generation-failure-audit.json", "utf8"));
  const scope = audit.scope as string, originalConfiguration = audit.originalConfiguration as CentralLearningConfiguration;
  const original = readCentralRuntimeRecords(board.rewardV2Facts ?? [], scope, board.sequence);
  const failed = original.state.completed.find(row => row.operation.operationId === H8_OPERATION);
  assert.ok(failed);
  assert.equal(failed.outcome, "failed");
  assert.ok(original.state.completed.length > 1, "retain the real earlier corrections and priority history");
  const configuration = { ...originalConfiguration, thoughtMaxTokens: 128000,
    generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 } };
  const f = await fixture(t, { actual: 8192, maximum: 16384, outcomes: ["returned"], seed: { board, scope, configuration } });
  const seeded = await f.store.read(scope);

  assert.equal(digest(canonicalJson(seeded.state)), digest(canonicalJson(original.state)), "copy the complete original runtime state without exposing private bodies in failures");
  assert.equal(digest(canonicalJson(seeded.history)), digest(canonicalJson(original.history)), "retain the complete original selection history");
  const before = await f.board(), rootBefore = before.centralLearningBudgets?.find(row => row.budgetId === f.rootRef.budgetId);
  assert.ok(rootBefore);
  const driver = f.makeDriver();
  try {
    const progress = await driver.drive(f.input);
    assert.equal(f.wires.length, 1,
      `real final565 must not select an old correction and remain capacity-blocked: ${canonicalJson(progress)}`);
    assertQuote(f.wires[0]!, f.requests[0]!, 16384);
    t.diagnostic(`actual H8 final565 actual wire maxOutputTokens=${f.wires[0]!.maxOutputTokens}`);
    const after = await f.board(), rootAfter = after.centralLearningBudgets?.find(row => row.budgetId === f.rootRef.budgetId);
    assert.ok(rootAfter);

    for (const accounting of rootBefore.accounting ?? []) assert.equal(
      digest(canonicalJson(rootAfter.accounting?.find(row => row.reservationId === accounting.reservationId))), digest(canonicalJson(accounting)));

    const state = await f.store.read(scope);

    assert.equal(digest(canonicalJson(state.state.completed.find(row => row.operation.operationId === H8_OPERATION))), digest(canonicalJson(failed)));
  } finally { await driver.close?.(); }

  assert.equal(digest(await readFile(boardFile)), H8_BOARD_SHA, "the original H8 fixture is never modified");
});
