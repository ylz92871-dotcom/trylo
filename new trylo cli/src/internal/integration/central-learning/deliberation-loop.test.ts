import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { sha256Hex } from "../../learning/control/hash.js";
import type { CentralLearningDriveInput,
  CentralRuntimeExecutionPort, CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { emptyUsage } from "../../ports/provider.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createTaskSourcePageReader } from "../learning-content/task-source-pages.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { centralMaterialFromPage, centralMaterialPageRef, createCentralMaterialCapabilities } from "./deliberation-material.js";
import { createCentralDeliberationReceiptsAtRoot, isCentralDeliberationReceiptRequest } from "./deliberation-receipts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import type { CentralLearningChange } from "./change-contract.js";
import { assertLearningChangeWireMatches, learningChangeBody, learningChangeIntent, learningChangeRead,
  learningChangeResponse, readLearningChangeWire } from "./change-test-support.js";

const SCOPE = "workspace:semantic-integrated", SOURCE = "source:original-contract", ISSUE = "issue:handoff-integrated";
const NOW = "2026-11-05T00:00:00.000Z", DETAIL = "Required reviewer already specified; remaining risk is order of confirmation.";
const GOAL = "Explain cross-specialty handoff rework.", NEXT_PAGE_START = 96;
const ALLOWANCE = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 200000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 };

test("real central driver reads an original later page, resumes on the same root and stops charging while waiting", async t => {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-semantic-loop-")), file = join(boardRoot, "original-contract.txt");

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const original = "Original task: compare the interface before changing handoff.\n" + "Documented background. ".repeat(20) + DETAIL;

  await writeFile(file, original, "utf8");
  const enabled = () => true, now = () => NOW, abort = new AbortController();
  t.after(() => abort.abort());
  const reported = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "report:original",
    issuedAt: now(), action: { kind: "report", scope: SCOPE, issueId: ISSUE, problemKey: "handoff:rework", report: { reportId: SOURCE,
      source: { subsystem: "workflow", taskId: "task:original", versionId: "workflow:original" },
      facts: ["Cross-specialty handoff required rework."], evidenceRefs: [SOURCE] } } }));

  assert.ok(reported.ok);
  const budget = await ensureCentralLearningBudget({ boardRoot, scope: SCOPE, allowance: ALLOWANCE, authorizationRef: "user:integrated", now, enabled });

  assert.ok(budget.ok);
  if (!budget.ok) return;

  const budgetId = budget.rootRef.budgetId, requested: { readonly start: number; readonly maximum: number }[] = [];
  const pages = createTaskSourcePageReader({ session: { async readMaterial(ref, _signal, start = 0, maximum = 4096) {
    if (ref !== SOURCE) return { ok: false, reason: "content_material_missing" };
    const text = await readFile(file, "utf8"), end = Math.min(text.length, start + maximum);
    requested.push({ start, maximum });
    return { ok: true, value: { ref, sessionId: "session:original", journalSequence: 0, sourceHash: sha256Hex(text),
      start, end, totalChars: text.length, text: text.slice(start, end), origin: "user_statement", originalScope: SCOPE,
      sourceRecordType: "original-contract-file" } };
  } }, board: { async readMaterial() { return { ok: false, reason: "content_material_missing" }; } },
    feedback: { readMaterial() { return { ok: false, reason: "content_feedback_material_missing" }; } } });
  const capabilities = createCentralMaterialCapabilities({ scope: SCOPE, enabled,
    resolvePage: (input, signal) => pages.read(input.ref, signal, input.start, input.maximumChars) });
  let resuming = false, recovered = false, readMaterial: CentralRuntimeMaterial | undefined;
  const progressMaterials = (phase: string): readonly CentralRuntimeMaterial[] => Array.from({ length: 10 }, (_value, index) => ({
    ref: `organization:${phase}:${index}`, kind: "organization", text: JSON.stringify({ role: "original_organization_progress", phase, index }), sourceRefs: [SOURCE] }));
  const source: CentralRuntimeSourcePort = {
    async snapshot() {
      const current = await createBoardReader(boardRoot).load();
      assert.ok(current.ok);

      if (resuming && wires.length === 1) {
        const compacted = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);
        const expectedRead = readMaterial;
        assert.ok(expectedRead);
        assert.equal(compacted.state.materials.some(row => row.ref === expectedRead.ref), false,
          "recovered original feedback has compacted the read body before preparing its interpretation");
        assert.ok(compacted.history.materials.some(row => row.ref === expectedRead.ref));
      }

      const first = await pages.read(SOURCE, abort.signal, 0, NEXT_PAGE_START);
      assert.ok(first.ok);

      return { boardSequence: current.state.sequence, opportunities: [{ subject: { plane: "agent", domain: "workflow", issueId: ISSUE },
        sourceRef: SOURCE, description: "Explain repeated handoff rework from its original contract.", constraints: [] }],
        sourceRefs: [SOURCE], materials: [centralMaterialFromPage(first.value)] };
    },

    read: (_scope, refs, maximum, signal) => capabilities.read(refs, maximum, signal),
  };
  const wires: string[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://semantic-loop.invalid/v1/chat/completions", model: "configured-model",
    apiKey: "local-controlled-transport", maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => {
      const wire = String(init?.body);
      wires.push(wire);
      assert.ok(wires.length <= 2, "waiting must not purchase another semantic request");
      const view = readLearningChangeWire(wire), opportunity = view.opportunities[0];
      assert.ok(opportunity);
      const explanation = "Keep the handoff purpose and investigate its actual contract.";
      const change: CentralLearningChange = wires.length === 1 ? { checkpoint: view.checkpoint,
        changes: [{ kind: "create", key: "handoff", subject: opportunity.handle, goal: GOAL,
          why: "Repeated rework may come from a missing contract or confirmation order.",
          conditions: ["Cross-specialty handoff"], knowledge: [], residual: ["Which of those explanations matches actual source?"],
          commitment: { purpose: "Separate contract absence from ordering.", assumptions: ["Original contract still applies."],
            reconsiderWhen: ["The source contradicts the missing-contract hypothesis."] }, sources: [opportunity.handle],
          next: { kind: "read", purpose: "Inspect the unseen contract detail.", expectedChange: "Test whether a reviewer is missing.",
            sources: [opportunity.handle], refs: [learningChangeRead(view, centralMaterialPageRef(SOURCE, NEXT_PAGE_START))], maximumChars: 1024 } }],
        explanation, sources: [opportunity.handle], alternatives: ["Inspect the contract", "Wait for actual use"],
      } : { checkpoint: view.checkpoint,
        changes: [{ kind: "revise", target: learningChangeIntent(view, GOAL),
          why: "Use the actual contract before deciding whether more research is useful.", set: {
            next: { kind: "wait", for: "use_feedback", sources: [opportunity.handle],
              reason: "Contract absence is contradicted; wait for actual use to assess confirmation order." },
          } }], explanation, sources: [opportunity.handle], alternatives: ["Inspect the contract", "Wait for actual use"],
      };
      const total = wires.length === 1 ? 173 : 227;

      return learningChangeResponse(change, { ...emptyUsage(), inputTokens: total - 50, outputTokens: 50, totalTokens: total });
    } });
  const execution: CentralRuntimeExecutionPort = {
    async consult() { throw new Error("consult_not_selected"); }, async prepare() { throw new Error("dispatch_not_selected"); },
    async execute() { throw new Error("dispatch_not_selected"); }, async recover() { return null; },
  };
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot, scope: SCOPE, budgetId, enabled });
  const fundingFor = (ownerId: string) => createCentralAccountingFundingAtRoot({ boardRoot, scope: SCOPE, budgetId,
    owner: { kind: "central_deliberation", ownerId }, now, enabled });
  const createDriver = (ownerId: string) => createCentralLearningDriver({ boardRoot, scope: SCOPE, enabled, now, source, execution,
    organization: { async recall() { return resuming ? progressMaterials("archive") : []; },

      async recoverResults() {
        if (!resuming || recovered) return [];
        recovered = true;
        return progressMaterials("recover");
      } },
    deliberation: createCentralModelDeliberation({ provider, model: "configured-model", funding: fundingFor(ownerId), receipts }) });
  const input: CentralLearningDriveInput = { scope: SCOPE, configuration: { schemaVersion: 1, configurationRef: "configuration:integrated",
    authorizationRef: "user:integrated", allowance: ALLOWANCE, rootRef: budget.rootRef },
    wake: { reason: "original_source_available", sourceRefs: [SOURCE] }, signal: abort.signal, publish() {} };
  const first = createDriver("central:initial");
  t.after(() => first.close?.());
  assert.equal((await first.drive(input)).state, "ready");
  assert.equal(wires.length, 1);
  const firstCheckpoint = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);
  const firstThought = firstCheckpoint.state.completed.find(row => row.operation.kind === "think");
  assert.ok(firstThought);
  const firstDelivery = await receipts.read(firstThought.operation.operationId);
  assert.ok(firstDelivery);
  const intentId = firstDelivery.output.intents[0]?.intentId;
  assert.ok(intentId);
  assert.equal((await first.drive(input)).state, "ready");
  assert.equal(wires.length, 1, "reading actual material is not a paid semantic draw");
  assert.ok(requested.some(read => read.start === NEXT_PAGE_START && read.maximum === 1024));
  const readCheckpoint = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);

  readMaterial = readCheckpoint.state.materials.find(row => row.text.includes(DETAIL));
  assert.ok(readMaterial);
  await first.close?.();
  resuming = true;
  const resumed = createDriver("central:resumed");
  t.after(() => resumed.close?.());
  assert.equal((await resumed.drive(input)).state, "waiting");
  assert.equal(wires.length, 2);
  const checkpoint = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);
  const resumedThought = checkpoint.state.completed.filter(row => row.operation.kind === "think").at(-1);
  assert.ok(resumedThought);
  const resumedDelivery = await receipts.read(resumedThought.operation.operationId);
  assert.ok(resumedDelivery);
  const delivery = resumedDelivery.request;
  assert.ok(resumedDelivery.wireEvidence);
  const deliveredView = assertLearningChangeWireMatches(wires[1]!, delivery);

  assert.ok(isCentralDeliberationReceiptRequest(delivery));
  const expectedRead = readMaterial;
  assert.ok(expectedRead);
  assert.deepEqual(delivery.materials.find(row => row.ref === expectedRead.ref), expectedRead,
    "the second actual wire must deliver the exact original read body after cold recovery and mechanical archive saves");
  assert.equal(delivery.materials.filter(row => row.ref === expectedRead.ref).length, 1);
  assert.equal(delivery.state.materials.length, 0);
  assert.equal(learningChangeBody(deliveredView, expectedRead.text).text, expectedRead.text);
  assert.equal(requested.filter(read => read.start === NEXT_PAGE_START).length, 1,
    "exact archive recall is not a second source read or operation");
  assert.equal(checkpoint.state.intents[0]?.intentId, intentId);
  assert.equal(checkpoint.state.intents[0]?.goal, GOAL);
  assert.equal(checkpoint.state.intents[0]?.continuation.kind, "waiting");
  assert.ok(checkpoint.history.materials.some(material => material.ref === expectedRead.ref));
  assert.equal(checkpoint.state.completed.filter(operation => operation.outcome === "returned").length, 3);
  const actual = await fundingFor("central:resumed").inspect();
  assert.ok(actual.ok);

  if (actual.ok) {
    assert.deepEqual(actual.projection.occupied, { tokens: 400, calls: 2, steps: 2 });
    assert.deepEqual(actual.projection.budget.accounting?.map(row => row.owner.ownerId), ["central:initial", "central:resumed"]);
    assert.ok(actual.projection.budget.accounting?.every(row => row.state === "settled" && row.usage?.kind === "reported"));
  }

  for (const row of checkpoint.state.completed.filter(operation => operation.operation.kind === "think")) {
    assert.ok(await receipts.read(row.operation.operationId), "each paid public response is recoverable from the original Board");
  }

  assert.equal((await resumed.drive({ ...input, wake: { reason: "duplicate_notification", sourceRefs: [SOURCE] } })).state, "waiting");
  assert.equal(wires.length, 2);
  assert.equal((await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE)).stateRef, checkpoint.stateRef);
  await resumed.close?.();
  await writeFile(file, `${original}\nActual later amendment: the receiving contract still needs an original review.`, "utf8");
  const known = new Set(checkpoint.history.materials.map(row => row.ref));
  const noRoomModel = createCentralModelDeliberation({ provider, model: "configured-model", funding: fundingFor("central:no-notice-room"), receipts });
  const noRoom = createCentralLearningDriver({ boardRoot, scope: SCOPE, enabled, now, execution,
    source: { ...source, async snapshot(scope, signal, query) {
      const observed = await source.snapshot(scope, signal, query);
      return { ...observed, sourceRefs: [...new Set([...observed.sourceRefs, ...observed.materials.map(row => row.ref)])] };
    } },
    deliberation: { ...noRoomModel, async prepareDelivery(request, signal) {
      const prepared = await noRoomModel.prepareDelivery!(request, signal);
      // Simulate a legal pure packing result with room for the current agenda
      // and issued-time metadata, but no new source body or navigation. The
      // real attempt still names intended refs; that is not actual exposure.
      return { ...prepared, materials: prepared.materials.filter(row => known.has(row.ref) || row.ref.startsWith("central-semantic-attempt:")) };
    } } });

  t.after(() => noRoom.close?.());
  const beforeNoRoom = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const blocked = await noRoom.drive(input);
    assert.equal(blocked.state, "waiting");
    assert.equal(blocked.reason, "central_deliberation_new_source_context_capacity");
  }

  assert.equal(wires.length, 2, "no source notice delivered means no paid automatic agenda, including repeated wakes");
  const afterNoRoom = await createCentralRuntimeStore({ boardRoot, enabled }).read(SCOPE);

  assert.equal(afterNoRoom.stateRef, beforeNoRoom.stateRef);
  assert.equal(afterNoRoom.revision, beforeNoRoom.revision);
  const afterNoRoomFunding = await fundingFor("central:no-notice-room").inspect();
  assert.ok(afterNoRoomFunding.ok);
  assert.deepEqual(afterNoRoomFunding.projection, actual.projection, "preflight must not archive, issue, reserve or settle");
});
