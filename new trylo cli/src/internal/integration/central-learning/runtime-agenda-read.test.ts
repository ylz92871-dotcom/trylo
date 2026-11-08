import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningDriveInput,
  CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState,
  CentralRuntimeExecutionPort, CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { centralMaterialPageRef } from "./deliberation-material.js";
import { centralMaterialNavigation } from "./deliberation-navigation.js";
import { nextCentralAgendaOperation } from "./runtime-agenda-read.js";
import { isCentralLearningRuntimeState } from "../../learning/central/runtime/validation.js";
import { selectCentralAutomaticOutput } from "./deliberation-output-investment.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { CentralRuntimeSourceError } from "./runtime-source.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

type ReadOperation = Extract<CentralLearningOperation, { readonly kind: "read" }>;

const pendingRead = (state: CentralLearningRuntimeState): unknown => "agendaRead" in state ? state.agendaRead : undefined;
const output = (intents: readonly CentralLearningIntentDraft[], agendaRead?: ReadOperation): CentralDeliberationOutput => ({
  schemaVersion: 1, intents, publicExplanation: "Inspect the original before deciding whether a learning purpose is supported.",
  sourceRefs: [], ...(agendaRead === undefined ? {} : { agendaRead }),
});

test("a returned agenda body survives hot-state pressure and reaches its original review without rereading", async t => {
  const parent = testScratchPath("central-agenda-read-tests");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "pressure-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const scope = "workspace:agenda-read-pressure", now = () => "2026-11-08T00:00:00.000Z";
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const empty = await store.read(scope);
  const held: CentralRuntimeMaterial[] = Array.from({ length: 4 }, (_, index) => ({
    ref: `source:live-wait-${index}`, kind: "source", text: "w".repeat(28000), sourceRefs: [],
  }));
  const body: CentralRuntimeMaterial = { ref: "source:returned-under-pressure", kind: "source", text: "original".repeat(4000), sourceRefs: [] };
  const notice = centralMaterialNavigation(body, { priority: 5, navigationOnly: false, companionRefs: [] }, "address");
  const read: ReadOperation = { kind: "read", operationId: "agenda-read:pressure", purpose: "Inspect the advertised original.",
    expectedChange: "Use the actual body in the next review.", sourceRefs: [notice.ref], refs: [body.ref], maximumChars: 32768 };
  const waiting: CentralLearningIntentDraft = { intentId: "intent:live-wait", subject: { plane: "agent", domain: "prompt", issueId: "issue:live-wait" },
    goal: "Await the original owner confirmation.", rationale: "The original evidence is still required.", conditions: [], knowledge: [], residual: [],
    commitment: { purpose: "Preserve the live wait", assumptions: [], reconsiderWhen: [] }, revisionReason: "Retain the original wait.", sourceRefs: [],
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "The original owner has not returned.", sourceRefs: held.map(row => row.ref) } } };
  const state = { ...empty.state, materials: [...held, notice], intents: [waiting], agendaRead: read };
  assert.ok(isCentralLearningRuntimeState(state));
  assert.equal(isCentralLearningRuntimeState({ ...state, materials: [...state.materials, body] }), false,
    "the observed body cannot share the original active checkpoint with all live waits");
  assert.equal((await store.append({ expectedRevision: empty.revision, previousRef: empty.stateRef, state,
    reason: "test_only_original_pending_read", sourceRefs: [notice.ref] })).status, "written");
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 10000, maxCalls: 16, maxSteps: 16, maxPromptChars: 200000 };
  const budget = await ensureCentralLearningBudget({ boardRoot, scope, now, enabled: () => true, allowance, authorizationRef: "test-only:pressure" });
  assert.ok(budget.ok);
  let reads = 0, reviews = 0, investments = 0;
  const unexpected = async (): Promise<never> => { throw new Error("unexpected_execution_during_original_review"); };
  const driver = createCentralLearningDriver({ boardRoot, scope, enabled: () => true, now,
    source: { async snapshot() { return { boardSequence: 0, opportunities: [], materials: [notice], sourceRefs: [notice.ref] }; },
      async read() { reads++; return [body]; } },
    execution: { consult: unexpected, prepare: unexpected, execute: unexpected, async recover() { return null; } },
    deliberation: {
      async selectAutomaticOutput(request) {
        investments++;
        return selectCentralAutomaticOutput(request, 32768, candidate => {
          assert.ok(candidate.materials.some(row => row.ref === body.ref && row.text === body.text));
          const outputSize = candidate.operation.kind === "think" ? candidate.operation.maxOutputTokens ?? 32768 : 32768;
          if (outputSize > 8192) throw new CentralDeliberationError("central_deliberation_context_capacity");
        });
      },
      async prepareDelivery(request) {
        assert.equal(request.operation.kind === "think" && request.operation.maxOutputTokens, 8192);
        assert.deepEqual(request.state.completed.find(row => row.operation.operationId === request.operation.operationId)?.operation, request.operation);
        return request;
      },
      async deliberate(request) {
      reviews++;
      assert.match(request.operation.operationId, /^central-agenda-read-review:/);
      assert.ok(request.materials.some(row => row.ref === body.ref && row.text === body.text));
      return output([waiting]);
    } } });
  t.after(() => driver.close?.());
  const input: CentralLearningDriveInput = { scope, configuration: { schemaVersion: 1, configurationRef: "configuration:pressure",
    authorizationRef: "test-only:pressure", allowance, rootRef: budget.rootRef,
    generationLimits: { defaultMaxOutputTokens: 32768, maxOutputTokens: 65536 } },
    wake: { reason: "original_read_pending", sourceRefs: [notice.ref] }, signal: new AbortController().signal, publish() {} };
  assert.equal((await driver.drive(input)).state, "ready");
  const returned = await store.read(scope);
  assert.equal(returned.state.agendaRead, undefined);
  assert.ok(returned.state.completed.some(row => row.operation.operationId === read.operationId && row.outcome === "returned"));
  assert.equal(returned.state.materials.some(row => row.ref === body.ref), false, "the exact durable original may leave hot memory");
  const archived = await store.lookup(scope, { kind: "material", ref: body.ref });
  assert.equal(archived.status, "found");
  if (archived.status === "found") assert.deepEqual(archived.value, body);
  await driver.drive(input);
  assert.equal(reads, 1);
  assert.equal(reviews, 1);
  assert.equal(investments, 1);
});

test("an empty agenda persists one original bounded read across restart before grounding a purpose and does not self-excite on a refused address", async t => {
  const parent = testScratchPath("central-agenda-read-tests");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-")), drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  t.after(async () => {
    for (const driver of drivers) await driver.close?.();
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    assert.ok(path.basename(boardRoot).startsWith("case-"));
    await rm(boardRoot, { recursive: true, force: true });
  });
  const scope = "workspace:agenda-read", now = () => "2026-11-05T00:00:00.000Z";
  let collect = true;
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 10000, maxCalls: 8, maxSteps: 8, maxPromptChars: 16000 };
  const budget = await ensureCentralLearningBudget({ boardRoot, scope, allowance,
    authorizationRef: "test-only:agenda-read", enabled: () => collect, now });
  assert.ok(budget.ok);
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: budget.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:prior-unconfirmed" }, now, enabled: () => collect });
  const reservationId = "central-deliberation:prior-unconfirmed-agenda-read";

  assert.ok((await funding.reserve({ reservationId, maxTokens: 31 })).ok);
  assert.ok((await funding.settle({ reservationId, usage: { kind: "unknown", reason: "prior_request_unconfirmed" } })).ok);
  const originalFees = await funding.inspect();
  assert.ok(originalFees.ok);

  const body: CentralRuntimeMaterial = { ref: "source:original-unit-contract", kind: "source",
    text: "The sender preserves minutes until the receiver explicitly requests seconds.", sourceRefs: [] };
  const unavailable: CentralRuntimeMaterial = { ref: "source:ambiguous-original-contract", kind: "source",
    text: "The original address currently has ambiguous ownership.", sourceRefs: [] };
  const navigation = (material: CentralRuntimeMaterial) => centralMaterialNavigation(material,
    { priority: 5, navigationOnly: false, companionRefs: [] }, "address");
  let currentNotice = navigation(body);

  assert.equal(isCentralUnreadNavigationMaterial(currentNotice), true);
  assert.equal(currentNotice.text.includes(body.text), false, "the first source notice supplies no quotable original body");
  const read = (operationId: string, material: CentralRuntimeMaterial, purpose: string): ReadOperation => ({
    kind: "read", operationId, purpose, expectedChange: "Obtain the original body before proposing a learning purpose.",
    sourceRefs: [material.ref], refs: [centralMaterialPageRef(material.ref, 0)], maximumChars: 1024,
  });
  const firstRead = read("agenda-read:original-unit", body, "Inspect the unread source-owned unit contract.");
  const refusedRead = read("agenda-read:ambiguous-original", unavailable, "Inspect the newly advertised original contract.");
  const sourceReads: { readonly refs: readonly string[]; readonly maximumChars: number }[] = [];
  const source: CentralRuntimeSourcePort = {
    async snapshot(requestScope, signal) {
      assert.equal(requestScope, scope);
      assert.equal(signal.aborted, false);
      const board = await createBoardReader(boardRoot).load();
      assert.ok(board.ok);
      return { boardSequence: board.state.sequence, opportunities: [], materials: [currentNotice], sourceRefs: [...currentNotice.sourceRefs] };
    },

    async read(requestScope, refs, maximumChars, signal) {
      assert.equal(requestScope, scope);
      assert.equal(signal.aborted, false);
      assert.equal(collect, true);
      assert.equal(maximumChars, 1024);
      sourceReads.push({ refs: [...refs], maximumChars });
      if (refs.length === 1 && refs[0] === refusedRead.refs[0]) throw new CentralRuntimeSourceError("content_material_ambiguous");
      assert.deepEqual(refs, firstRead.refs);
      assert.ok(body.text.length <= maximumChars);
      return [body];
    },
  };
  const unexpected = async (): Promise<never> => { throw new Error("An agenda-owned source read cannot dispatch or consult without a learning intent"); };
  const execution: CentralRuntimeExecutionPort = { consult: unexpected, prepare: unexpected, execute: unexpected, async recover() { return null; } };
  const requests: CentralDeliberationRequest[] = [];
  let grounded: CentralLearningIntentDraft | undefined;
  const createDriver = () => {
    const driver = createCentralLearningDriver({ boardRoot, scope, enabled: () => collect, now, source, execution,
      deliberation: { async deliberate(request) {
        requests.push(request);
        assert.deepEqual(request.opportunities, [], "source browsing must not invent a PA nomination");

        if (requests.length === 1) {
          assert.deepEqual(request.state.intents, []);
          assert.ok(request.materials.some(row => row.ref === currentNotice.ref && isCentralUnreadNavigationMaterial(row)));
          assert.equal(request.materials.some(row => row.ref === body.ref && row.text === body.text), false);
          return output([], firstRead);
        }

        if (requests.length === 2) {
          assert.deepEqual(request.state.intents, [], "reading an original does not pre-create a learning goal");
          assert.ok(request.materials.some(row => row.ref === body.ref && row.text === body.text));
          assert.ok(request.operation.sourceRefs.includes(body.ref));
          const intentId = "central-purpose:unit-preservation";

          grounded = { intentId, subject: { plane: "central", questionRef: intentId },
            goal: "Identify when a handoff must preserve source units and when explicit conversion is required.",
            rationale: "The read original makes the receiver condition observable.", conditions: ["The receiver contract is explicit"],
            knowledge: [], residual: ["Whether this condition recurs in later real handoffs"],
            commitment: { purpose: "Compare later real receiver contracts", assumptions: [], reconsiderWhen: ["A receiver requests conversion"] },
            revisionReason: "Create the purpose only after the exact original source has been read.", sourceRefs: [body.ref],
            derivation: { relation: "Source preservation and requested conversion are distinct interface conditions.",
              whenRelevant: "A later real handoff has a unit-bearing quantity.", parentRefs: [body.ref],
              citations: [{ evidenceRef: body.ref, quote: body.text }] },
            continuation: { kind: "waiting", wait: { kind: "facts", reason: "Wait for a different real receiver contract.", sourceRefs: [body.ref] } } };

          return output([grounded]);
        }

        assert.equal(requests.length, 3, "unchanged notices and local read refusals cannot purchase another deliberation");
        assert.ok(grounded);
        return output([grounded], refusedRead);
      } } });

    drivers.push(driver);
    return driver;
  };
  const input: CentralLearningDriveInput = { scope,
    configuration: { schemaVersion: 1, configurationRef: "configuration:agenda-read", authorizationRef: "test-only:agenda-read",
      allowance, rootRef: budget.rootRef }, wake: { reason: "original_business_notice", sourceRefs: currentNotice.sourceRefs },
    signal: new AbortController().signal, publish() {} };
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true }), first = createDriver();

  assert.equal((await first.drive(input)).state, "ready");
  const pending = await store.read(scope);
  assert.deepEqual(pendingRead(pending.state), firstRead);
  assert.deepEqual(pending.state.intents, []);
  assert.deepEqual(sourceReads, []);
  assert.equal(requests.length, 1);
  const oldNavigation: CentralLearningRuntimeState = { ...pending.state, agendaRead: { ...firstRead, sourceRefs: [] },
    materials: [currentNotice, ...Array.from({ length: 10 }, (_, index): CentralRuntimeMaterial => ({
      ref: `irrelevant-old:${index}`, kind: "knowledge", text: `Old unrelated material ${index}.`, sourceRefs: [] }))] };

  assert.ok(compactCentralWorkingSet(oldNavigation, oldNavigation).materials.some(row => row.ref === currentNotice.ref),
    "a pending advertised page retains its original navigation even when explicit sources are omitted");
  await first.close?.();

  const resumed = createDriver();
  collect = false;
  assert.equal((await resumed.drive(input)).state, "waiting");
  assert.equal((await store.read(scope)).stateRef, pending.stateRef);
  assert.deepEqual(sourceReads, []);
  assert.equal(requests.length, 1);
  collect = true;
  assert.equal((await resumed.drive(input)).state, "ready");
  const obtained = await store.read(scope);

  assert.equal(pendingRead(obtained.state), undefined);
  const completedRead = obtained.state.completed.find(row => row.operation.operationId === firstRead.operationId);
  assert.ok(completedRead);
  assert.equal(completedRead.intentId, "central:agenda");
  assert.equal(completedRead.outcome, "returned");
  assert.deepEqual(completedRead.resultRefs, [body.ref]);
  assert.ok(obtained.history.materials.some(row => row.ref === body.ref));
  assert.deepEqual(sourceReads, [{ refs: firstRead.refs, maximumChars: 1024 }]);
  assert.equal(requests.length, 1);
  assert.equal((await resumed.drive(input)).state, "waiting");
  assert.equal(requests.length, 2);
  const waiting = await store.read(scope);
  assert.equal(waiting.state.intents[0]?.intentId, grounded?.intentId);
  const renamedReturned = { ...completedRead, operation: { ...firstRead, operationId: "agenda-read:renamed-original-unit",
    purpose: "Inspect the same original unit contract using different wording." } };
  const renamedState = { ...waiting.state, completed: [
    ...waiting.state.completed.filter(row => row.operation.operationId !== firstRead.operationId), renamedReturned] };

  assert.equal(nextCentralAgendaOperation(renamedState, waiting.history), undefined,
    "the same target and returned references retain their original review despite renamed operation prose");
  const amendedBody = { ...body, ref: "source:original-unit-contract:v2", text: `${body.text} The receiver now explicitly requests seconds.` };
  const amendedState = { ...renamedState, materials: [...renamedState.materials, amendedBody], completed: [
    ...renamedState.completed.filter(row => row !== renamedReturned), { ...renamedReturned, resultRefs: [amendedBody.ref] }] };

  assert.equal(nextCentralAgendaOperation(amendedState, waiting.history)?.kind, "think",
    "a genuinely different original result version remains eligible for its own bounded review");

  for (let index = 0; index < 2; index += 1) assert.equal((await resumed.drive({ ...input,
    wake: { reason: "duplicate_business_notification", sourceRefs: currentNotice.sourceRefs } })).state, "waiting");

  assert.equal(requests.length, 2);
  assert.equal((await store.read(scope)).stateRef, waiting.stateRef);

  currentNotice = navigation(unavailable);
  const nextInput = { ...input, wake: { reason: "different_original_source_notice", sourceRefs: currentNotice.sourceRefs } };

  assert.equal((await resumed.drive(nextInput)).state, "ready");
  assert.equal(requests.length, 3);
  assert.deepEqual(pendingRead((await store.read(scope)).state), refusedRead);
  assert.equal((await resumed.drive(nextInput)).state, "waiting");
  const refused = await store.read(scope), failure = refused.state.completed.find(row => row.operation.operationId === refusedRead.operationId);

  assert.ok(failure);
  assert.equal(failure.intentId, "central:agenda");
  assert.equal(failure.outcome, "failed");
  assert.equal(pendingRead(refused.state), undefined);
  assert.ok((refused.history.readFailures ?? []).length > 0);
  assert.equal(JSON.parse(failure.publicResult).reason, "content_material_ambiguous");

  for (let index = 0; index < 2; index += 1) assert.equal((await resumed.drive(nextInput)).state, "waiting");

  assert.equal(requests.length, 3);
  assert.equal(sourceReads.length, 2);
  await resumed.close?.();

  // Only the operation wording changes. The real original address and its
  // refusal condition remain in the same verified Board history after restart.
  const renamedRead = { ...refusedRead, operationId: "agenda-read:reworded-ambiguous", purpose: "Inspect the same unresolved original using revised wording." };
  const saved = await store.append({ expectedRevision: refused.revision, previousRef: refused.stateRef,
    state: { ...refused.state, agendaRead: renamedRead }, reason: "test_only_reworded_original_read", sourceRefs: [] });

  assert.equal(saved.status, "written");
  const cold = createDriver();
  assert.equal((await cold.drive(nextInput)).state, "waiting");
  assert.equal(pendingRead((await store.read(scope)).state), undefined);
  assert.equal(sourceReads.length, 2, "a known same-address refusal cannot become a second source observation");
  assert.equal(requests.length, 3, "a renamed read cannot self-trigger another paid computation");
  const finalFees = await funding.inspect();
  assert.ok(finalFees.ok);
  assert.deepEqual(finalFees.projection, originalFees.projection, "source browsing never erases, refunds or reclassifies an original unknown fee");
});
