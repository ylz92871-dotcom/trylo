import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { sessionContentAddress } from "../learning-content/sources/session.js";
import { createCentralRuntimeMaterials } from "../../surface/cli/central-runtime-materials.js";
import type { CliContext } from "../../surface/cli/context.js";
import { methodBoardRoot } from "../../surface/cli/learning-sink.js";
import { sessionPath } from "../../surface/cli/session-paths.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { centralMaterialDeliveryPlan } from "./deliberation-delivery.js";
import { mergeRuntimeMaterials, validateAgendaTransition } from "../../learning/central/runtime/transitions.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import type { CentralLearningChange } from "./change-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { assertLearningChangeWireMatches, learningChangeBody, learningChangeIntent, learningChangeRead,
  readLearningChangeWire } from "./change-test-support.js";

const AT = "2026-11-05T08:00:00.000Z", BUDGET = "budget:capacity", PURPOSE = "Preserve the open receiver-contract purpose while its workflow research is running.";
const ALLOWANCE = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 32000 };
const ENDPOINT = "https://capacity-capture.invalid/v1/chat/completions";
const CONNECTION_REF = `central-provider-connection:${contentHashOf({ providerId: "local-capacity", kind: "openai-compatible",
  model: "configured-model", endpointHash: contentHashOf(ENDPOINT), accountId: "local-capacity" })}`;
const RECOVERY_BODY = "OPAQUE_DOMAIN_RECOVERY_BODY_MUST_STAY_WITH_ORIGINAL_OWNER";
const OLD_RESULT = "OLD_PUBLIC_RESULT_BODY_MUST_BE_READ_FROM_ITS_ORIGINAL_REF";

function proposedGrounding(checkpoint: string, source: string, quote: string): CentralLearningChange {
  return { checkpoint, changes: [{ kind: "create", key: "capacity-grounding-probe", subject: "central",
    goal: "Resolve the receiver applicability question from the delivered evidence.",
    why: "Source visibility is being checked at the actual delivery boundary.",
    conditions: [], knowledge: [], residual: [], commitment: { purpose: "Interpret the actual source.", assumptions: [], reconsiderWhen: [] },
    sources: [source], grounding: { relation: "The original correction changes a receiver precondition.", whenRelevant: "Receiver contract applicability.",
      parents: [source], citations: [{ source, quote }] },
    next: { kind: "wait", for: "facts", reason: "Await original use feedback.", sources: [source] } }],
    explanation: "Check only the source visibility contract.", sources: [source] };
}

function context(root: string): CliContext {
  return { homeDir: root, cwd: join(root, "workspace"), env: { TRYLO_HOME: join(root, "home") }, nodeVersion: "v24.0.0", stdinIsTty: false,
    now: () => Date.parse(AT), newId: prefix => `${prefix}-capacity`,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } },

    readDir(directory) { try { return readdirSync(directory).map(name => {
      const stat = statSync(join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }); } catch { return []; } },

    writeFile(file, value) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
}

async function normalTask(ctx: CliContext, index: number, workspaceId: string) {
  const id = `capacity-task-${index}`, store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, id) });

  assert.ok((await store.start({ sessionId: id, createdAt: AT, fingerprint: { schemaVersion: "1", workspaceId,
    providerId: "local-capacity", model: "local-capacity", toolCatalogHash: "local-catalog" } })).ok);

  try {
    assert.ok((await store.append({ type: "turn_start", sessionId: id, turnId: `turn-${id}`, at: AT, payload: { userSourceAvailable: true } })).ok);
    assert.ok((await store.append({ type: "turn_input", sessionId: id, turnId: `turn-${id}`, at: AT,
      payload: { text: `Task ${index}: inspect the receiver contract and preserve sender units before delivering its artifact.` } })).ok);

    for (let item = 0; item < 8; item += 1) {
      const observation = `Task ${index}, observation ${item}: receiver contract requires its original field types; preserve the source version and distinguish accepted payload from an unverified report. `
        + `The sender record and the receiving schema are separately addressable for task ${index}; a later numeric-only interface is a different precondition. `;
      assert.ok((await store.append({ type: "transcript_item", sessionId: id, turnId: `turn-${id}`, at: AT,
        payload: { kind: "tool_result", sequence: item, toolCallId: `read-${index}-${item}`, name: "read_file",
          output: observation, outcome: "succeeded", truncated: false } })).ok);
    }

    return { id, feedbackSource: sessionContentAddress({ sessionId: id, journalSequence: 10 }) };
  } finally { await store.release(); }
}

test("eight original task catalogs and live research fit a 32000-character central request without duplicating source bodies", async t => {
  const base = resolve(tmpdir()), root = await mkdtemp(join(base, "trylo-central-capacity-"));
  assert.equal(dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = context(root), scope = ctx.cwd, boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), workspaceId = "workspace-capacity";
  const normal = [];

  for (let index = 0; index < 8; index += 1) normal.push(await normalTask(ctx, index, workspaceId));

  const source = createCentralRuntimeMaterials({ ctx, workspaceId, enabled: () => true }), signal = new AbortController().signal;
  const snapshot = await source.snapshot(scope, signal);
  const catalogs = snapshot.materials.filter(material => JSON.parse(material.text).role === "host_normal_turn_source_catalog_not_read_body");

  assert.equal(catalogs.length, 8, "the capacity input must come from the real eight-task source directory");
  assert.ok(catalogs.every(material => JSON.parse(material.text).entries.length === 8));
  const originalSource = snapshot.materials.find(material => !catalogs.includes(material));
  assert.ok(originalSource);
  const owner = createCentralOrganizationService({ boardRoot, scope, enabled: () => true });
  const before = await owner.read();
  assert.equal(before.status, "ready");
  if (before.status !== "ready") return;

  const decision = await owner.freezeDecision({ kind: "decision", decisionRef: "decision:capacity", purposeRef: "intent:capacity",
    context: { purpose: PURPOSE, conditionKeys: ["receiver-contract"], known: [], residual: ["Which receiver preconditions still need research?"] },
    program: { programRef: "program:capacity", depth: "Bounded original contract research", timing: "now" },
    expectation: { change: "Identify when the original handoff practice transfers.", uncertainties: ["No economic comparison is known."] },
    alternatives: ["Wait for actual use"], issueRefs: ["issue:capacity"], stageRefs: ["operation:running"], sourceRefs: [normal[0]!.feedbackSource], experienceUse: null }, before.revision);

  assert.equal(decision.status, "saved");
  if (decision.status !== "saved") return;

  const feedback = { kind: "feedback" as const, decisionRef: "decision:capacity", unitRef: "feedback:original-capacity", supersedes: null,
    sourceRefs: [normal[0]!.feedbackSource], result: { kind: "correction" as const,
      statement: "The numeric-only receiver rejects the old unit label; keep this exception local to that receiver contract.",
      conditions: "Only the original numeric-only receiver; other receivers still require explicit original units." } };
  const observed = await owner.observe(feedback, decision.revision);
  assert.equal(observed.status, "saved");
  if (observed.status !== "saved") return;

  // The actual producer binds the observed fact to its typed feedback view and citation capability.
  const feedbackMaterial = createOrganizationFeedbackMaterial(scope, observed.factId, feedback);
  const opened = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "open-capacity", issuedAt: AT,
    action: { kind: "open_budget", expectedSequence: observed.revision, budget: { schemaVersion: 1, budgetId: BUDGET, scope,
      unit: "total_model_tokens", limits: { tokens: 32000, calls: 4, steps: 4 }, authorizationRef: "user:capacity" } } }));

  assert.ok(opened.ok);
  const intent: CentralLearningIntentDraft = { intentId: "intent:capacity", subject: { plane: "agent", domain: "workflow", issueId: "issue:capacity" },
    goal: PURPOSE, rationale: "The original purpose remains unresolved while its domain worker has the work.",
    conditions: ["Use the exact original receiver contract"], knowledge: [], residual: ["Do not restart the already running domain research."],
    commitment: { purpose: PURPOSE, assumptions: ["The original source remains available."], reconsiderWhen: ["A relevant receiver correction arrives."] },
    revisionReason: "Actual feedback changes applicability, without cancelling the original purpose.", sourceRefs: [originalSource.ref],
    continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: ["work:capacity-running"], reason: "Original workflow research is already in flight." } } };
  const dispatch = { kind: "dispatch" as const, operationId: "operation:capacity-running", purpose: PURPOSE,
    expectedChange: "Return a source-bound applicability comparison.", sourceRefs: [originalSource.ref], allowance: ALLOWANCE };
  const state = { schemaVersion: 1 as const, scope, intents: [intent], completed: [{ intentId: intent.intentId,
    operation: { kind: "read" as const, operationId: "operation:capacity-prior", purpose: "Read the original prior result.",
      expectedChange: "Preserve its address for later comparison.", sourceRefs: [originalSource.ref], refs: [originalSource.ref], maximumChars: 1024 },
    outcome: "returned" as const, resultRefs: ["result:capacity-prior"], publicResult: OLD_RESULT }], running: [{ intentId: intent.intentId,
    operation: dispatch, workRef: "work:capacity-running", frame: { kind: "workflow", originalStageRef: "stage:capacity-running", originalGrantRef: "grant:capacity", nativeCursor: RECOVERY_BODY } }],
    materials: mergeRuntimeMaterials(snapshot.materials, [feedbackMaterial]), consumedSourceRefs: snapshot.sourceRefs };
  const working = compactCentralWorkingSet(state, state);

  assert.ok(working.materials.some(material => material.ref === feedbackMaterial.ref));
  assert.equal(working.running[0]?.workRef, "work:capacity-running");
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  const projection = centralBudgetProjection(loaded.state, BUDGET);
  assert.ok(projection);
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: BUDGET, boardSequence: loaded.state.sequence,
    configuration: { schemaVersion: 1, configurationRef: "configuration:capacity", authorizationRef: "user:capacity",
      providerConnectionRef: CONNECTION_REF, allowance: ALLOWANCE },
    resources: { boardSequence: loaded.state.sequence, budgetId: BUDGET, limits: projection.budget.limits, occupied: projection.occupied,
      available: projection.available, status: projection.status, holdReason: projection.holdReason ?? null }, stateRef: "state:capacity", state: working,
    opportunities: [], materials: mergeRuntimeMaterials(snapshot.materials, working.materials), organization: [feedbackMaterial],
    operation: { kind: "think", operationId: "operation:capacity-reconsider", purpose: PURPOSE,
      expectedChange: "Inspect the actual correction while preserving current work and deciding what is useful next.",
      sourceRefs: [...new Set([feedbackMaterial.ref, ...snapshot.sourceRefs])] } };
  const captured: string[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint: ENDPOINT, model: "configured-model",
    apiKey: "local-only-capacity", maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => {
      captured.push(String(init?.body));
      throw new Error("local_capture_complete_no_semantic_answer");
    } });
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: BUDGET,
    owner: { kind: "central_deliberation", ownerId: "central:capacity" }, now: () => AT, enabled: () => true });
  const model = createCentralModelDeliberation({ provider, model: "configured-model", funding, outputMode: "tool" });
  const beforePacking = await funding.inspect();
  assert.ok(beforePacking.ok);
  assert.ok(model.prepareDelivery);
  const prepared = await model.prepareDelivery(request, signal);

  assert.deepEqual(prepared.configuration, request.configuration);
  assert.deepEqual(await model.prepareDelivery(prepared, signal), prepared,
    "packing an already prepared delivery must preserve its exact visible source set and agenda");
  // Diagnose this same crowded request without buying another computation:
  // preserve its mandatory material, agenda and running work, plus this feedback.
  const originalMaterials = mergeRuntimeMaterials(request.materials, request.organization, request.state.materials);
  const deliveryPlan = centralMaterialDeliveryPlan(request, originalMaterials);
  const mandatory = originalMaterials.filter(material => deliveryPlan.get(material.ref)?.priority === 0 && material.ref !== feedbackMaterial.ref);
  const organizationRefs = new Set(request.organization.map(material => material.ref));
  let feedbackOnlyFit = false, feedbackOnlyBody = false, feedbackOnlyFailure: string | null = null;

  try {
    const minimum = await model.prepareDelivery({ ...request,
      materials: mandatory.filter(material => !organizationRefs.has(material.ref)),
      organization: [...mandatory.filter(material => organizationRefs.has(material.ref)), feedbackMaterial],
      state: { ...request.state, materials: [] } }, signal);
    feedbackOnlyFit = true;
    feedbackOnlyBody = createCentralLearningChangeView(minimum).exposure.some(row => row.ref === feedbackMaterial.ref && row.kind === "body");
  } catch (error) { feedbackOnlyFailure = error instanceof Error ? error.message : "unknown_minimum_quote_failure"; }

  const afterPacking = await funding.inspect();
  assert.ok(afterPacking.ok);
  assert.deepEqual(afterPacking.projection, beforePacking.projection, "pure delivery packing must not reserve or settle budget");
  let failure = "none";

  try { await model.deliberate(request, signal); }
  catch (error) { failure = error instanceof Error ? error.message : "unknown_local_failure"; }

  assert.equal(captured.length, 1, `rich original-source request must reach the local provider; actual=${failure}; requestChars=${canonicalJson(request).length}; materialChars=${working.materials.reduce((sum, material) => sum + material.text.length, 0)}`);
  const wire = captured[0]!, view = readLearningChangeWire(wire), wireBytes = new TextEncoder().encode(wire).length;

  assertLearningChangeWireMatches(wire, prepared);
  const delivery = prepared, input = createCentralLearningChangeView(delivery);

  assert.equal(view.checkpoint, input.view.checkpoint);
  const sender: { readonly max_tokens: number } = JSON.parse(wire), outputTokens = sender.max_tokens;

  assert.ok(Number.isSafeInteger(outputTokens) && outputTokens > 0 && outputTokens <= 8192,
    "the actual sender output allowance must stay within the configured default ceiling");
  assert.ok(wire.length <= 32000, `actual wire chars=${wire.length}`);
  assert.ok(wireBytes + 512 + outputTokens <= 32000,
    `actual wire bytes=${wireBytes}; plus overhead allowance and actual output=${wireBytes + 512 + outputTokens}`);
  const receipt = model.receipts()[0];
  assert.ok(receipt, "the captured attempt must retain its original accounting receipt");
  assert.ok(receipt.maxTokens <= ALLOWANCE.maxTokens, "the original reservation must fit the authorized total-token ceiling");
  assert.deepEqual(delivery.state.materials, []);
  assert.deepEqual(delivery.state.intents, request.state.intents);
  assert.match(learningChangeIntent(view, PURPOSE), /^i/, "the actual view must retain the unresolved original purpose");
  assert.deepEqual(delivery.state.running[0]?.operation, dispatch);
  assert.equal(delivery.state.running[0]?.workRef, "work:capacity-running");
  assert.equal(delivery.state.running[0]?.frame.role, "domain_recovery_frame_not_delivered");
  assert.equal(wire.includes(RECOVERY_BODY), false);
  assert.equal(wire.includes(OLD_RESULT), false);
  assert.equal(delivery.state.completed[0]?.operation.operationId, "operation:capacity-prior");
  assert.match(delivery.state.completed[0]!.publicResult, /not delivered/);
  const canonicalBodies = [...delivery.materials, ...delivery.organization], bodies = view.materials;

  assert.equal(new Set(canonicalBodies.map(material => material.ref)).size, canonicalBodies.length);
  assert.equal(new Set(bodies.map(material => material.handle)).size, bodies.length);
  assert.equal(bodies.length, canonicalBodies.length, "the actual view must retain every selected body or navigation exactly once");

  for (const material of bodies) assert.equal(canonicalJson(view).split(JSON.stringify(material.text)).length - 1, 1,
    "each complete body or source navigation occurs once in the actual context");

  t.diagnostic(JSON.stringify({ feedbackOnlyFit, feedbackOnlyBody, feedbackOnlyFailure,
    unchangedCeiling: ALLOWANCE.maxTokens, actualWireBytes: wireBytes, actualOutputTokens: outputTokens,
    actualReservation: receipt.maxTokens, feedbackPriority: deliveryPlan.get(feedbackMaterial.ref)?.priority,
    preparedFeedback: canonicalBodies.filter(material => material.ref === feedbackMaterial.ref || material.text.includes(feedbackMaterial.ref))
      .map(material => ({ ref: material.ref, chars: material.text.length, exactBody: material.text === feedbackMaterial.text })),
    actualExposure: input.exposure.filter(row => row.ref === feedbackMaterial.ref),
    selectedMaterials: canonicalBodies.map(material => ({ ref: material.ref, chars: material.text.length,
      originalPriority: deliveryPlan.get(material.ref)?.priority ?? null })) }));
  const feedbackBody = learningChangeBody(view, material => material.text === feedbackMaterial.text);

  t.diagnostic(JSON.stringify({ originalRequestChars: canonicalJson(request).length, actualWireChars: wire.length,
    actualWireBytes: wireBytes, actualOutputTokens: outputTokens, deliveredBodies: bodies.length, feedbackBodyDelivered: feedbackBody.delivery === "body" }));
  assert.equal(bodies.filter(material => material.text === feedbackMaterial.text).length, 1);
  assert.equal(feedbackBody.delivery, "body");
  assert.equal(delivery.materials.some(material => material.ref === feedbackMaterial.ref), false);
  assert.equal(delivery.organization.find(material => material.ref === feedbackMaterial.ref)?.text, feedbackMaterial.text);
  const omitted = bodies.flatMap(material => {
    const value: unknown = JSON.parse(material.text);
    if (typeof value !== "object" || value === null || !("role" in value) || value.role !== "central_source_body_not_delivered"
      || !("originalRef" in value) || typeof value.originalRef !== "string") return [];
    const original = catalogs.find(catalog => catalog.ref === value.originalRef);
    return original === undefined ? [] : [{ material, value, original }];
  });

  assert.ok(omitted.length > 0, "oversized source bodies must remain readable navigation, not silently vanish");
  const unread = omitted[0]!;

  assert.ok("readRef" in unread.value && unread.value.readRef === unread.original.ref);
  assert.ok("sourceHash" in unread.value && unread.value.sourceHash === contentHashOf(unread.original.text));
  assert.ok("totalChars" in unread.value && unread.value.totalChars === unread.original.text.length);
  assert.equal(canonicalBodies.some(material => material.ref === unread.original.ref), false);
  assert.equal(bodies.some(material => material.delivery === "body" && material.text === unread.original.text), false);
  const unreadRead = learningChangeRead(view, unread.original.ref);

  assert.ok(unread.material.reads.some(read => read.address === unread.original.ref && read.handle === unreadRead));
  const compile = (change: CentralLearningChange) => compileCentralLearningChange(change, delivery, input.dictionary);

  assert.throws(() => compile(proposedGrounding(view.checkpoint, unreadRead,
    "host_normal_turn_source_catalog_not_read_body")), /handle_unbound|unread|citation/);
  assert.throws(() => compile(proposedGrounding(view.checkpoint, unread.material.handle,
    "central_source_body_not_delivered")), /handle_unbound|unread|citation/);
  const restored = await source.pageReader.read(unread.original.ref, signal, 0, 8192);
  assert.ok(restored.ok);
  assert.equal(restored.value.sourceHash, contentHashOf(unread.original.text));
  assert.equal(restored.value.text, unread.original.text);
  const grounded = compile(proposedGrounding(view.checkpoint, feedbackBody.handle, feedback.result.statement));

  assert.equal(validateAgendaTransition(delivery, grounded), null,
    "a correction actually delivered once under organization remains usable source evidence at the canonical boundary");
  assert.doesNotThrow(() => decodeCentralDeliberation(grounded, delivery, []));
  t.diagnostic(JSON.stringify({ unreadCatalogs: omitted.length }));
});
