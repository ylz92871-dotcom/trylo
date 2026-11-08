import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { buildProvider } from "../../surface/cli/provider-build.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput, CentralLearningIntentDraft,
  CentralRuntimeExecutionPort, CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";
import { FROZEN_C19_TOOL_RECEIPT } from "./testing/c20-c19-tool-receipt.fixture.test.js";
import { activePurposeReadRef, createActivePurposeOriginal } from "./active-purpose-delivery.js";

const scope = "workspace:active-purpose-integration", issueId = "issue:method-transfer";
const now = () => "2026-11-05T00:00:00.000Z";
const endpoint = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions", modelName = "deepseek-v4.1-flash";
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "config:active-purpose",
  authorizationRef: "user:bounded-original-authorization", thoughtMaxTokens: 64000,
  allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 200000, maxCalls: 8, maxSteps: 8, maxPromptChars: 25000 } };

function purpose(id: string): CentralLearningIntentDraft {
  const observations = Array.from({ length: 12 }, (_, index) => ({
    statement: `Case ${id}/${index + 1}: the observed review transferred only when the caller supplied the target contract, the concrete change and an independently recorded result. Keep this condition explicit before reusing that review.`,
    conditions: `Observed case ${index + 1} in this workspace; other tools, missing receipts and a changed contract remain outside this observation.`,
    sourceRefs: ["report:method-transfer"],
  }));
  return { intentId: `intent:${id}`, subject: { plane: "agent", domain: "prompt", issueId },
    goal: `Understand when review ${id} transfers to a later development task without assuming that a returned proposal is a verified benefit.`,
    rationale: "The original report distinguishes the actual review condition from the outcome. Preserve its unresolved conditions until an independent receipt can resolve them.",
    conditions: ["Use the original source version", "Do not infer success from a missing observation"], knowledge: observations,
    residual: observations.map((_, index) => `For case ${index + 1}, compare the next actual use against its original contract and check whether the required independent result was recorded before generalizing the method.`),
    commitment: { purpose: `Keep the original question ${id} open while a discriminating result is absent.`,
      assumptions: ["The target contract remains the one named in the source"],
      reconsiderWhen: ["The same owner returns an independently qualified result", "A contrary observation changes an explicit condition"] },
    revisionReason: "The original source establishes this unresolved transfer question.", sourceRefs: ["report:method-transfer"],
    continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: ["report:method-transfer"], reason: "Await the original discriminating result." } } };
}

type WireRead = { handle: string; address: string };

type WireMaterial = { text: string; intents?: { handle: string; intentId: string }[] };

type PublicView = { role: string; checkpoint: string; agenda: { intentId: string; goal: string }[];
  agendaNavigation?: { entries: { read: WireRead }[] }; materials: WireMaterial[] };

function publicInput(wire: { messages: { content?: unknown }[] }): PublicView {
  for (const message of wire.messages) {
    if (typeof message.content !== "string" || !message.content.startsWith("{")) continue;
    const value = JSON.parse(message.content) as PublicView;
    if (value.role === "central_learning_public_input") return value;
  }
  throw new Error("The normal provider wire must contain the public input.");
}

function returnedContent(value: object): Response {
  const content = JSON.stringify(value);
  const frames = [
    { choices: [{ delta: { content: content.slice(0, 17) }, finish_reason: null }] },
    { choices: [{ delta: { content: content.slice(17) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 70, total_tokens: 160 } },
  ];

  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("normal provider JSON content preserves the original 25k purpose review, funded cold receipt and frozen C19 v4 tool receipt", async t => {
  const base = testScratchPath("active-purpose-integration");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));

  assert.ok(!path.relative(base, boardRoot).startsWith(".."));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const reported = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "report:initial", issuedAt: now(), action: {
    kind: "report", scope, issueId, problemKey: "method:transfer", report: { reportId: "report:method-transfer",
      source: { subsystem: "method", taskId: "task:original", versionId: "method:original" },
      facts: ["The original review condition has not yet been checked against an independent later result."], evidenceRefs: ["evidence:original"] } } }));

  assert.ok(reported.ok, JSON.stringify(reported));
  const budget = await ensureCentralLearningBudget({ boardRoot, scope, allowance: configuration.allowance,
    authorizationRef: configuration.authorizationRef, now, enabled: () => true });
  assert.ok(budget.ok);
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true }), initial = await store.read(scope);
  const first = purpose("first"), untouched = purpose("second");

  t.diagnostic(`canonical purpose chars: first=${canonicalJson(first).length}, second=${canonicalJson(untouched).length}; prompt cap=${configuration.allowance.maxPromptChars}`);
  const seeded = await store.append({ expectedRevision: initial.revision, previousRef: initial.stateRef,
    state: { ...initial.state, intents: [first, untouched] }, reason: "Persist the two original unresolved purposes", sourceRefs: ["report:method-transfer"] });

  assert.equal(seeded.status, "written");
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: budget.projection.budget.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:active-purpose" }, now, enabled: () => true });
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: budget.projection.budget.budgetId, enabled: () => true });
  const normalSource = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true });
  const seenReads: string[][] = [], readBodies: (readonly CentralRuntimeMaterial[])[] = [];
  const source: CentralRuntimeSourcePort = { snapshot: (...args) => normalSource.snapshot(...args),

    async read(...args) {
      seenReads.push([...args[1]]);
      const result = await normalSource.read(...args);
      readBodies.push(result);
      return result;
    } };
  const views: PublicView[] = [];
  const operationIds: string[] = [];
  let selectedRead: WireRead | undefined;
  let preparedRequest: CentralDeliberationRequest | undefined;
  let providerAssertion: unknown;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
      try {
      assert.equal(String(url), endpoint);
      assert.equal(init?.redirect, "manual");
      const wire = JSON.parse(String(init?.body));

      assert.equal(wire.model, modelName);
      assert.deepEqual(wire.response_format, { type: "json_object" });
      assert.equal(wire.tools, undefined);
      assert.equal(wire.tool_choice, undefined);
      assert.equal(wire.response_schema, undefined);
      const view = publicInput(wire);
      views.push(view);
      assert.ok(preparedRequest);
      operationIds.push(preparedRequest.operation.operationId);
      const input = createCentralLearningChangeView(preparedRequest);
      const system = wire.messages.filter((row: { role: string }) => row.role === "system")
        .map((row: { content: string }) => row.content).join("\n");
      const menus = [...system.matchAll(/(?:^|\n)Current typed choices: ([^\r\n]*?)\. Each category is /gu)];

      assert.equal(menus.length, 1, "the actual HTTP system guide must advertise one concrete choice menu");
      const choices = menus[0]![1]!.split("; ");

      assert.ok(input.dictionary.selectionHandles);

      for (const category of ["source", "read"] as const) {
        const expected = input.dictionary.selectionHandles(category);
        assert.ok(expected.length > 0, `this fixture must exercise concrete ${category} choices`);
        const actual = choices.filter((row: string) => row.startsWith(`${category}=`));
        assert.equal(actual.length, 1, `the actual HTTP guide must enumerate ${category} exactly once`);
        assert.deepEqual(JSON.parse(actual[0]!.slice(category.length + 1)), expected,
          `the actual HTTP ${category} choices must exactly match this prepared request's dictionary`);
      }

      if (views.length === 1) {
        assert.equal(input.view.checkpoint, view.checkpoint, "the negative capability assertion binds the exact normally prepared request");
        assert.deepEqual(view.agenda, input.view.agenda, "the normal HTTP transport must preserve the complete prepared purpose projection");
        assert.throws(() => compileCentralLearningChange({ checkpoint: view.checkpoint, changes: [{ kind: "end", target: untouched.intentId,
          goalState: "open", why: "A guessed raw identifier must not authorize changing the unread purpose." }],
        explanation: "Reject the unopened target." }, preparedRequest!, input.dictionary), /central_learning_change_handle_unbound/);

        // The JSON encoding may fit both complete purposes. Use only the
        // authority actually delivered; do not force a read merely to preserve
        // the tool wire's larger-overhead path through this same fixture.
        if (view.agendaNavigation === undefined) {
          assert.equal(view.agenda.length, 2, "both complete original purposes must be delivered when navigation is unnecessary");
          assert.deepEqual(view.agenda.map(row => row.goal), [first.goal, untouched.goal]);
          const target = view.agenda.find(row => row.goal === first.goal);
          assert.ok(target);
          return returnedContent({ checkpoint: view.checkpoint, changes: [{ kind: "end", target: target.intentId, goalState: "open",
            why: "The complete delivered original remains open while this investment ends." }],
          explanation: "End only the reviewed original investment and preserve the other original purpose." });
        }

        assert.equal(view.agenda.length, 0, "unread current purposes receive no editing handles");
        assert.ok(!input.dictionary.entries.some(entry => entry.kind === "intent" && entry.ref === untouched.intentId));
        selectedRead = view.agendaNavigation.entries[0]!.read;

        return returnedContent({ checkpoint: view.checkpoint, changes: [], explanation: "Read the original first purpose before choosing whether to end its investment.", inspect: {
          purpose: "Inspect the selected original active purpose", expectedChange: "Decide with its actual full conditions in view",
          refs: [selectedRead.handle], maximumChars: 20000 } });
      }

      assert.equal(views.length, 2, "only the initial selection and actual original review need paid thoughts");
      const editable = view.materials.flatMap(material => material.intents ?? []);
      const target = editable.find(entry => entry.intentId === first.intentId);

      assert.ok(target, "the complete same-version original grants its original-ID change capability");
      assert.ok(!editable.some(entry => entry.intentId === untouched.intentId), "the unopened purpose must have no edit capability");

      return returnedContent({ checkpoint: view.checkpoint, changes: [{ kind: "end", target: target.handle, goalState: "open",
        why: "The selected original purpose remains open; end this investment while awaiting its discriminating result." }],
      explanation: "End only the actually inspected investment and preserve the other original purpose." });
      } catch (error) {
        providerAssertion = error;
        throw error;
      }
    };
  const provider = buildProvider({ providerId: "openai-compatible", model: modelName, endpoint,
    apiKey: "synthetic-not-a-credential", workspaceRoot: boardRoot, requestAttemptPolicy: "single_request" });

  assert.ok(!("code" in provider));
  assert.deepEqual(provider.responseFormats, ["json_object"]);
  const fork = provider.fork?.([]);
  assert.ok(fork);
  assert.deepEqual(fork.responseFormats, ["json_object"]);
  const execution: CentralRuntimeExecutionPort = {
    async consult() { throw new Error("This reading counterexample must not allocate a worker."); },
    async prepare() { throw new Error("This reading counterexample must not dispatch a worker."); },
    async execute() { throw new Error("This reading counterexample must not execute a worker."); },
    async recover() { return null; },
  };
  const create = () => {
    const model = createCentralModelDeliberation({ provider, model: modelName, funding, receipts });
    return createCentralLearningDriver({ boardRoot, scope, now, enabled: () => true, source, execution,
      deliberation: { ...model, async prepareDelivery(...args) {
        preparedRequest = await model.prepareDelivery!(...args);
        return preparedRequest;
      } } });
  };
  const signal = new AbortController().signal;
  const input: CentralLearningDriveInput = { scope, configuration, signal, wake: { reason: "original_report", sourceRefs: ["report:method-transfer"] }, publish() {} };
  const driver = create();
  t.after(() => driver.close?.());
  const firstProgress = await driver.drive(input);

  if (providerAssertion !== undefined) throw providerAssertion;

  t.diagnostic(`initial decision progress: ${JSON.stringify(firstProgress)}`);
  assert.equal(views.length, 1, `the original purposes must reach the normal provider under the original cap: ${JSON.stringify(firstProgress)}`);
  const afterSelection = await store.read(scope);

  if (selectedRead !== undefined) {
    assert.ok(afterSelection.state.agendaRead, "the selection must use the existing durable agenda read");
    assert.deepEqual(afterSelection.state.intents, [first, untouched]);
    assert.deepEqual(afterSelection.state.agendaRead.refs, [selectedRead.address]);
    const readProgress = await driver.drive(input);

    assert.equal(readProgress.state, "ready");
    assert.deepEqual(seenReads, [[selectedRead.address]]);
    assert.equal(views.length, 1, "reading the original is not another model computation");
    const reviewed = await driver.drive(input);

    if (providerAssertion !== undefined) throw providerAssertion;

    assert.equal(views.length, 2, `actual original review must fit the same original cap: ${JSON.stringify(reviewed)}`);
  } else {
    assert.equal(afterSelection.state.agendaRead, undefined);
    assert.deepEqual(seenReads, [], "complete delivery needs no extra source read");
  }

  const expectedCalls = selectedRead === undefined ? 1 : 2;
  const final = await store.read(scope), ended = final.state.intents.find(intent => intent.intentId === first.intentId);

  assert.equal(ended?.continuation.kind, "ended");
  assert.equal(canonicalJson(final.state.intents.find(intent => intent.intentId === untouched.intentId)), canonicalJson(untouched));
  const spent = await funding.inspect();
  assert.ok(spent.ok);
  assert.equal(spent.projection.occupied.tokens, expectedCalls * 160);
  assert.equal(spent.projection.occupied.calls, expectedCalls);
  const rootIdentity = canonicalJson(spent.projection.budget);

  await driver.close?.();
  const restarted = create();
  t.after(() => restarted.close?.());
  const recovered = await createCentralRuntimeStore({ boardRoot, enabled: () => true }).read(scope);

  assert.deepEqual(recovered.state, final.state);
  const coldSource = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true });

  assert.deepEqual(await coldSource.read(scope, [activePurposeReadRef(scope, first)], 20000, signal),
    selectedRead === undefined ? [createActivePurposeOriginal(scope, first)] : readBodies[0],
    "the original same-version purpose remains exactly readable from the original ledger after restart");
  const restartProgress = await restarted.drive(input);

  assert.equal(restartProgress.state, "waiting");
  assert.equal(restartProgress.reason, "central_waiting_for_relevant_facts");
  assert.equal(views.length, expectedCalls, "cold restart must not replay the original paid thoughts");
  const afterRestart = await funding.inspect();
  assert.ok(afterRestart.ok);

  if (afterRestart.ok) assert.equal(canonicalJson(afterRestart.projection.budget), rootIdentity);

  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);

  if (board.ok) assert.equal(board.state.centralLearningBudgets?.length, 1, "there is still only the original root");

  const coldReceipts = createCentralDeliberationReceiptsAtRoot({ boardRoot, scope,
    budgetId: budget.projection.budget.budgetId, enabled: () => true });

  for (const operationId of operationIds) {
    const delivery = await coldReceipts.read(operationId);
    assert.ok(delivery);
    const proof = delivery.wireEvidence;
    assert.ok(proof);
    assert.equal(proof.schemaVersion, 2);
    assert.equal(proof.format.kind, "json_object");
    assert.equal(proof.inputVersion, "central-learning-change-input-v4");
    assert.ok(isCentralDeliberationWireEvidence(proof, delivery.request, delivery.output));
  }

  assert.equal(operationIds.length, expectedCalls);
  const legacyRoot = path.join(boardRoot, "frozen-c19-tool-receipt");
  await mkdir(legacyRoot);
  const legacyLog = path.join(legacyRoot, "board-events.ndjson");

  assert.equal(sha256Hex(FROZEN_C19_TOOL_RECEIPT.boardLog), FROZEN_C19_TOOL_RECEIPT.logSha256);
  await writeFile(legacyLog, FROZEN_C19_TOOL_RECEIPT.boardLog, "utf8");
  const legacyReceipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: legacyRoot,
    scope: FROZEN_C19_TOOL_RECEIPT.scope, budgetId: FROZEN_C19_TOOL_RECEIPT.budgetId, enabled: () => true });
  const legacy = await legacyReceipts.read(FROZEN_C19_TOOL_RECEIPT.operationId);
  assert.ok(legacy?.wireEvidence);
  assert.equal(legacy.wireEvidence.schemaVersion, 1);
  assert.equal(legacy.wireEvidence.format.kind, "tool");
  assert.equal(legacy.wireEvidence.inputVersion, "central-learning-change-input-v4");
  assert.equal(contentHashOf(legacy.wireEvidence), FROZEN_C19_TOOL_RECEIPT.proofHash);
  assert.ok(isCentralDeliberationWireEvidence(legacy.wireEvidence, legacy.request, legacy.output));
  assert.equal(await readFile(legacyLog, "utf8"), FROZEN_C19_TOOL_RECEIPT.boardLog, "cold C20 reads never rewrite the frozen C19 tool log");
  assert.equal(views.length, expectedCalls, "historical receipt reading must make no provider request");
  t.diagnostic(`same original root=${budget.projection.budget.budgetId}; model calls=${views.length}; original reads=${seenReads.length}; settled tokens=${spent.projection.occupied.tokens}; settled calls=${spent.projection.occupied.calls}; cold reader state/body/root unchanged; re-instantiated driver progress=${JSON.stringify(restartProgress)}`);
});
