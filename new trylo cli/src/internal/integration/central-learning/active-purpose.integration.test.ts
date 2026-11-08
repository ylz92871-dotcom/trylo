import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { canonicalJson } from "../../learning/control/hash.js";
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

const scope = "workspace:active-purpose-integration", issueId = "issue:method-transfer";
const now = () => "2026-11-05T00:00:00.000Z";
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

type PublicView = { role: string; checkpoint: string; agenda: unknown[]; agendaNavigation?: { entries: { read: WireRead }[] }; materials: WireMaterial[] };

function publicInput(wire: { messages: { content?: unknown }[] }): PublicView {
  for (const message of wire.messages) {
    if (typeof message.content !== "string" || !message.content.startsWith("{")) continue;
    const value = JSON.parse(message.content) as PublicView;
    if (value.role === "central_learning_public_input") return value;
  }
  throw new Error("The normal provider wire must contain the public input.");
}

function returnedChange(value: object): Response {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "decision:one", type: "function", function: {
      name: "submit_learning_change", arguments: JSON.stringify(value) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 70, total_tokens: 160 } },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("normal central quote can inspect one active purpose, end its original ID and retain the other across a cold ledger read", async t => {
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
  let selectedRead: WireRead | undefined;
  let preparedRequest: CentralDeliberationRequest | undefined;
  let providerAssertion: unknown;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://active-purpose.invalid/v1/chat/completions", model: "local-only", apiKey: "local-only",
    maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => {
      try {
      const view = publicInput(JSON.parse(String(init?.body)));
      views.push(view);

      if (views.length === 1) {
        assert.ok(view.agendaNavigation, "the complete two-purpose quote must fall back to selectable navigation");
        assert.equal(view.agenda.length, 0, "unread current purposes receive no editing handles");
        assert.ok(preparedRequest);
        const input = createCentralLearningChangeView(preparedRequest);

        assert.equal(input.view.checkpoint, view.checkpoint, "the negative capability assertion binds the exact normally prepared request");
        assert.ok(!input.dictionary.entries.some(entry => entry.kind === "intent" && entry.ref === untouched.intentId));
        assert.throws(() => compileCentralLearningChange({ checkpoint: view.checkpoint, changes: [{ kind: "end", target: untouched.intentId,
          goalState: "open", why: "A guessed raw identifier must not authorize changing the unread purpose." }],
        explanation: "Reject the unopened target." }, preparedRequest!, input.dictionary), /central_learning_change_handle_unbound/);
        selectedRead = view.agendaNavigation.entries[0]!.read;

        return returnedChange({ checkpoint: view.checkpoint, changes: [], explanation: "Read the original first purpose before choosing whether to end its investment.", inspect: {
          purpose: "Inspect the selected original active purpose", expectedChange: "Decide with its actual full conditions in view",
          refs: [selectedRead.handle], maximumChars: 20000 } });
      }

      assert.equal(views.length, 2, "only the initial selection and actual original review need paid thoughts");
      const editable = view.materials.flatMap(material => material.intents ?? []);
      const target = editable.find(entry => entry.intentId === first.intentId);

      assert.ok(target, "the complete same-version original grants its original-ID change capability");
      assert.ok(!editable.some(entry => entry.intentId === untouched.intentId), "the unopened purpose must have no edit capability");

      return returnedChange({ checkpoint: view.checkpoint, changes: [{ kind: "end", target: target.handle, goalState: "open",
        why: "The selected original purpose remains open; end this investment while awaiting its discriminating result." }],
      explanation: "End only the actually inspected investment and preserve the other original purpose." });
      } catch (error) {
        providerAssertion = error;
        throw error;
      }
    } });
  const execution: CentralRuntimeExecutionPort = {
    async consult() { throw new Error("This reading counterexample must not allocate a worker."); },
    async prepare() { throw new Error("This reading counterexample must not dispatch a worker."); },
    async execute() { throw new Error("This reading counterexample must not execute a worker."); },
    async recover() { return null; },
  };
  const create = () => {
    const model = createCentralModelDeliberation({ provider, model: "local-only", funding, receipts, outputMode: "tool" });
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

  t.diagnostic(`initial navigation progress: ${JSON.stringify(firstProgress)}`);
  assert.equal(views.length, 1, `navigation must reach the normal provider under the original cap: ${JSON.stringify(firstProgress)}`);
  const afterSelection = await store.read(scope);

  assert.ok(afterSelection.state.agendaRead, "the selection must use the existing durable agenda read");
  assert.deepEqual(afterSelection.state.intents, [first, untouched]);
  assert.deepEqual(afterSelection.state.agendaRead.refs, [selectedRead!.address]);
  const readProgress = await driver.drive(input);

  assert.equal(readProgress.state, "ready");
  assert.deepEqual(seenReads, [[selectedRead!.address]]);
  assert.equal(views.length, 1, "reading the original is not another model computation");
  const reviewed = await driver.drive(input);

  if (providerAssertion !== undefined) throw providerAssertion;

  assert.equal(views.length, 2, `actual original review must fit the same original cap: ${JSON.stringify(reviewed)}`);
  const final = await store.read(scope), ended = final.state.intents.find(intent => intent.intentId === first.intentId);

  assert.equal(ended?.continuation.kind, "ended");
  assert.equal(canonicalJson(final.state.intents.find(intent => intent.intentId === untouched.intentId)), canonicalJson(untouched));
  const spent = await funding.inspect();
  assert.ok(spent.ok);
  assert.equal(spent.projection.occupied.tokens, 320);
  assert.equal(spent.projection.occupied.calls, 2);
  const rootIdentity = canonicalJson(spent.projection.budget);

  await driver.close?.();
  const restarted = create();
  t.after(() => restarted.close?.());
  const recovered = await createCentralRuntimeStore({ boardRoot, enabled: () => true }).read(scope);

  assert.deepEqual(recovered.state, final.state);
  const coldSource = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true });

  assert.deepEqual(await coldSource.read(scope, [selectedRead!.address], 20000, signal), readBodies[0],
    "the original same-version purpose remains exactly readable from the original ledger after restart");
  const restartProgress = await restarted.drive(input);

  assert.equal(restartProgress.state, "waiting");
  assert.equal(restartProgress.reason, "central_waiting_for_relevant_facts");
  assert.equal(views.length, 2, "cold restart must not replay the original paid thoughts");
  const afterRestart = await funding.inspect();
  assert.ok(afterRestart.ok);

  if (afterRestart.ok) assert.equal(canonicalJson(afterRestart.projection.budget), rootIdentity);

  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);

  if (board.ok) assert.equal(board.state.centralLearningBudgets?.length, 1, "there is still only the original root");

  t.diagnostic(`same original root=${budget.projection.budget.budgetId}; model calls=${views.length}; original reads=${seenReads.length}; settled tokens=${spent.projection.occupied.tokens}; settled calls=${spent.projection.occupied.calls}; cold reader state/body/root unchanged; re-instantiated driver progress=${JSON.stringify(restartProgress)}`);
});
