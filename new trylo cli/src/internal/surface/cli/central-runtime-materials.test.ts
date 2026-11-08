import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { SessionPort } from "../../ports/session.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { buildContentPacket } from "../../learning/central/content/material.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { buildContentRecord } from "../../integration/learning-content/records.js";
import { centralKnowledgeQueryRef, centralMaterialFromPage, centralMaterialPageRef, readCentralMaterialPageRef } from "../../integration/central-learning/deliberation-material.js";
import { sessionContentAddress, sessionTaskAddress } from "../../integration/learning-content/sources/session.js";
import { sessionSourceAddressCatalogForIssue } from "../../integration/learning-content/sources/session-issue-address.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { createRuntimeSessionMaterials } from "./central-runtime-materials-session.js";
import { readSessionPublicTurnAddress } from "../../integration/learning-content/sources/session-public-turn.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { createCentralDeliberationReceiptsAtRoot } from "../../integration/central-learning/deliberation-receipts.js";
import { createRewardV2BoardPort } from "../../integration/reward/v2-board-port.js";
import { sessionPath, sessionsDir } from "./session-paths.js";
import { createCentralRuntimeAdvisoryAccess } from "./central-runtime-advisory-access.js";
import { createRuntimeCentralAdvisoryPublisher } from "../../integration/central-learning/runtime-central-advisory-publication.js";
import { lookupCentralAdvisories, readCentralAdvisoryRecords } from "../../integration/central-learning/central-advisory-records.js";
import { collectCentralAdvisoryAccessSourceInventory } from "../../integration/central-learning/central-advisory-source-ancestry.js";
import { createCentralAdvisorySourceAccess } from "../../integration/learning-content/sources/advisory-access.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";

const at = "2026-11-05T04:00:00.000Z", signal = new AbortController().signal;
const PAGE_ENVELOPE_CHARS = 4096, CATALOG_ENVELOPE_CHARS = 8192;

function assertEnvelopeBudget(materials: readonly { readonly text: string }[], maximumChars: number) {
  assert.ok(materials.reduce((sum, material) => sum + material.text.length, 0) <= maximumChars,
    "the complete public material JSON envelopes fit the requested read budget");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-central-materials-"));
  const ctx: CliContext = { homeDir: root, cwd: path.join(root, "workspace"), env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: () => 0, newId: prefix => `${prefix}-fixture`,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } },

    readDir(directory) { try { return readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }); } catch { return []; } },

    writeFile(file, value) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };

  return { ctx, workspaceId: "workspace-materials" };
}

async function session(ctx: CliContext, id: string, workspaceId: string, userText: string, learning = false): Promise<SessionPort> {
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, id) });

  assert.ok((await store.start({ sessionId: id, createdAt: at,
    fingerprint: { schemaVersion: "1", workspaceId, providerId: "local", model: "local", toolCatalogHash: "catalog" } })).ok);

  for (const row of [
    { type: "turn_start" as const, payload: { userSourceAvailable: !learning } },
    { type: "turn_input" as const, payload: { text: userText } },
    { type: "transcript_item" as const, payload: { kind: "tool_result", sequence: 0, toolCallId: "central-call", name: "central_learning",
      output: "CENTRAL_CONTROL_OUTPUT_MUST_NOT_BE_BUSINESS_EVIDENCE", outcome: "succeeded", truncated: false } },
  ]) assert.ok((await store.append({ ...row, sessionId: id, turnId: `turn-${id}`, at })).ok);

  return store;
}

test("a cold advisory host authenticates an original public session address before checking its retained opaque source ref", async () => {
  const f = fixture(), store = await session(f.ctx, "advisory-original", f.workspaceId, "The original receiver declares a structured representation.");
  try {
    const scope = f.ctx.cwd, budgetId = "budget:host-advisory", options = { ...f, enabled: () => true };
    const address = sessionContentAddress({ sessionId: "advisory-original", journalSequence: 2 });
    const page = await createCentralRuntimeMaterials(options).pageReader.read(address, signal, 0, 8192);
    assert.ok(page.ok);
    const material = centralMaterialFromPage(page.value), raw = material.sourceRefs[0]!;

    assert.equal(page.value.ref, address);
    assert.equal(page.value.originalRef, raw);
    assert.notEqual(raw, address);
    const knowledge = { statement: "Compare the declared receiver before reusing this observation.",
      conditions: "The receiver declares the same representation.", sourceRefs: [raw] };
    const intent: CentralLearningIntentDraft = { intentId: "intent:host-advisory", subject: { plane: "central", questionRef: "question:receiver" },
      goal: "Understand the receiver condition", rationale: "An original public observation is conditional", conditions: [knowledge.conditions],
      knowledge: [knowledge], residual: ["No later benefit is established"], commitment: { purpose: "Retain the observed condition", assumptions: [], reconsiderWhen: [] },
      revisionReason: "The original public observation was read", sourceRefs: [raw],
      continuation: { kind: "ended", goalState: "open", reason: "No further investment is selected" } };
    const boardRoot = methodBoardRoot(f.ctx.homeDir, f.ctx.env), board = createRewardV2BoardPort(boardRoot, () => true), prefix = await board.read();
    const state = emptyCentralRuntimeState(scope), stateRef = initialCentralRuntimeRef(scope);
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: prefix.revision, stateRef, state,
      configuration: { schemaVersion: 1, configurationRef: "configuration:host-advisory", authorizationRef: "authorization:host-advisory",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
      resources: { boardSequence: prefix.revision, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 }, occupied: { tokens: 0, calls: 0, steps: 0 },
        available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null }, opportunities: [], materials: [material], organization: [],
      operation: { kind: "think", operationId: "operation:host-advisory", purpose: "Choose an explicit conditional handoff",
        expectedChange: "Retain the real source, conditions and uncertainty", sourceRefs: [raw] } };
    const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent], publicExplanation: "Retain the observation without claiming benefit", sourceRefs: [raw],
      knowledgeHandoffs: [{ kind: "publish", intentId: intent.intentId, knowledgeHash: contentHashOf(knowledge),
        whenRelevant: knowledge.conditions, uncertainty: "The observation is not an independent benefit assessment" }] };
    const delivery = await createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId, enabled: () => true }).save({ request, output }, signal);
    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
    const applied = buildCentralRuntimeRecord({ previousRef: stateRef, state: { ...state, intents: [intent], completed: [{ intentId: "central:agenda",
      operation: request.operation, outcome: "returned", resultRefs: [resultRef], publicResult: output.publicExplanation }] },
      reason: "central_deliberation_returned", sourceRefs: output.sourceRefs,
      opportunityConsideration: { operationId: request.operation.operationId, deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [] } });

    assert.equal((await board.append((await board.read()).revision, applied, signal)).status, "written");
    const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot, scope, enabled: () => true, access: createCentralRuntimeAdvisoryAccess(options) });
    const saved = await publisher.recordDecision({ scope, appliedStateRef: applied.id }, signal);
    assert.equal(saved.results[0]!.status, "published");
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    const published = lookupCentralAdvisories(loaded.state, scope)[0]!;
    assert.deepEqual(published.sourceRefs, [raw]);
    assert.ok(published.accessSourceRefs.includes(address));
    assert.ok(published.accessSourceRefs.includes(raw));
    const inventory = collectCentralAdvisoryAccessSourceInventory(loaded.state, scope, { intent, knowledge, delivery }), controls = new Set(inventory.controlRefs);
    const originalGate = createCentralAdvisorySourceAccess({ board: loaded.state, scope, enabled: () => true,
      sessionSource: createRuntimeSessionMaterials(options).reader });
    const checked = await originalGate({ ref: published.id, version: published.version,
      sourceRefs: [address, ...published.accessSourceRefs.filter(ref => !controls.has(ref))] }, signal);

    assert.equal(checked.status, "allowed");
    assert.ok(checked.sourceRefs.includes(raw), "the real PA source gate still checks the opaque original, rather than dropping it");
    const originalPublication = readCentralAdvisoryRecords(loaded.state.rewardV2Facts ?? [], scope, loaded.state.sequence)
      .find(row => row.ref === published.version);

    assert.equal(originalPublication?.value.kind, "publish");

    if (originalPublication?.value.kind !== "publish") throw new Error("Expected the original publication");

    const journalPath = sessionPath(f.ctx.homeDir, f.ctx.env, "advisory-original"), journal = readFileSync(journalPath, "utf8");

    try {
      writeFileSync(journalPath, `${journal}not-a-valid-original-journal-record\n`);
      await assert.rejects(createCentralRuntimeAdvisoryAccess(options)(loaded.state, originalPublication.value, signal),
        /central_runtime_journal_unavailable|content_material_journal|session_record|session_journal/u,
        "a corrupt original owner read must remain a read failure, never a durable source-access refusal");
    } finally { writeFileSync(journalPath, journal); }
  } finally { await store.release(); }
});

test("a considered frozen turn suppresses only the same automatic directory version and preserves its unread continuation", async () => {
  const f = fixture(), store = await session(f.ctx, "ordinary-frontier", f.workspaceId, "Receiver premise. ".repeat(700));
  const turnId = "turn-ordinary-frontier", address = sessionContentAddress({ sessionId: "ordinary-frontier", turnId });
  const options = { ...f, enabled: () => true };

  try {
    assert.ok((await store.append({ type: "transcript_item", sessionId: "ordinary-frontier", turnId, at,
      payload: { kind: "assistant_text", sequence: 1, blockId: "handback", text: "A bounded handback awaits actual use", redacted: false } })).ok);
    const source = createCentralRuntimeMaterials(options), initial = await source.snapshot(f.ctx.cwd, signal);
    const catalog = initial.materials.find(row => row.ref.startsWith("central-business-catalog:"));
    assert.ok(catalog);
    const material = (await source.read(f.ctx.cwd, [address], PAGE_ENVELOPE_CHARS, signal))[0];
    assert.ok(material);
    const page = JSON.parse(material.text), frozen = readSessionPublicTurnAddress(page.originalRef);
    assert.ok(frozen);
    assert.equal(page.complete, false);
    assert.ok(page.nextRef);
    const original = material.text;
    const cold = createRuntimeSessionMaterials(options);
    const known = await cold.catalogs(signal, [], 8, [page.originalRef]);

    assert.equal(known.items.length, 0);
    assert.equal(known.hasMore, false);
    assert.deepEqual(known.consideredItems[0]?.catalog, (await createRuntimeSessionMaterials(options).catalogs(signal)).items[0]?.catalog,
      "the same directory remains available as passive context without a new automatic trigger");
    const continued = await cold.reader.readMaterial(page.originalRef, signal, page.end, 500);

    assert.ok(continued.ok);
    assert.equal(continued.value.start, page.end);
    assert.equal(continued.value.sourceHash, frozen.sourceHash);
    assert.equal(material.text, original, "consideration never rewrites the delivered page or marks the unread tail complete");
    assert.equal((await source.read(f.ctx.cwd, [catalog.ref], CATALOG_ENVELOPE_CHARS, signal))[0]?.sourceRefs.includes(catalog.ref), true,
      "the exact directory remains readable");

    const budgetId = "budget:ordinary-frontier", state = emptyCentralRuntimeState(f.ctx.cwd);
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope: f.ctx.cwd, budgetId, boardSequence: 0,
      configuration: { schemaVersion: 1, configurationRef: "configuration:frontier", authorizationRef: "authorization:frontier",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
      resources: { boardSequence: 0, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 }, occupied: { tokens: 0, calls: 0, steps: 0 },
        available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
      stateRef: initialCentralRuntimeRef(f.ctx.cwd), state, materials: [material], organization: [], opportunities: [],
      operation: { kind: "think", operationId: "consider-ordinary-position", purpose: "Consider whether more reading is useful",
        expectedChange: "Choose the next step", sourceRefs: [material.ref] } };
    const output = { schemaVersion: 1 as const, intents: [], publicExplanation: "Await actual use feedback", sourceRefs: [] };
    const boardRoot = methodBoardRoot(f.ctx.homeDir, f.ctx.env), saved = await createCentralDeliberationReceiptsAtRoot({ boardRoot,
      scope: f.ctx.cwd, budgetId, enabled: () => true }).save({ request, output });
    const board = createRewardV2BoardPort(boardRoot, () => true), prefix = await board.read();
    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;

    await board.append(prefix.revision, buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(f.ctx.cwd),
      state: { ...state, completed: [{ intentId: "central:agenda", operation: request.operation, outcome: "returned",
        resultRefs: [resultRef], publicResult: output.publicExplanation }] }, reason: "central_deliberation_returned", sourceRefs: [],
      opportunityConsideration: { operationId: request.operation.operationId, deliveryRef: saved.deliveryRef, resultRef, sourceRefs: [] } }));
    const restarted = createCentralRuntimeMaterials(options), passive = await restarted.snapshot(f.ctx.cwd, signal);

    assert.deepEqual(passive.sourceRefs, [], "cold original receipts suppress only the same automatic discovery position");
    assert.ok(passive.materials.some(row => row.ref === catalog.ref), "the original directory remains passive material for another legitimate purpose");
    assert.equal(await restarted.owns(f.ctx.cwd, catalog.ref), true);
    assert.equal((await restarted.read(f.ctx.cwd, [catalog.ref], CATALOG_ENVELOPE_CHARS, signal))[0]?.sourceRefs.includes(catalog.ref), true);

    const otherVersion = `session-public-turn:${JSON.stringify({ sessionId: frozen.sessionId, sourceHash: "0".repeat(64), through: frozen.through, turnId: frozen.turnId })}`;

    assert.equal((await createRuntimeSessionMaterials(options).catalogs(signal, [], 8, [otherVersion])).items.length, 1,
      "the same position with different content hash is not considered");
    assert.ok((await store.append({ type: "transcript_item", sessionId: "ordinary-frontier", turnId, at,
      payload: { kind: "assistant_text", sequence: 2, blockId: "later-result", text: "A later actual receiver result", redacted: false } })).ok);
    const advanced = await createRuntimeSessionMaterials(options).catalogs(signal, [], 8, [page.originalRef]);

    assert.equal(advanced.items.length, 1);
    assert.ok(advanced.items[0]!.catalog.through > frozen.through,
      "a later original result in the same turn remains a new discovery position");
  } finally { await store.release(); }
});

test("snapshot reads original user text while its session writer is live and pages retain exact source hash and coordinates", async () => {
  const f = fixture(), original = "Original task: verify the ownership contract. " + "Real source details. ".repeat(600);
  const store = await session(f.ctx, "normal", f.workspaceId, original);

  try {
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true });
    const snapshot = await source.snapshot(f.ctx.cwd, signal);

    assert.ok(snapshot.materials.some(material => material.text.includes("Original task: verify")));
    assert.equal(JSON.stringify(snapshot).includes("CENTRAL_CONTROL_OUTPUT_MUST_NOT_BE_BUSINESS_EVIDENCE"), false);
    const material = snapshot.materials.find(item => item.text.includes("Original task: verify"));
    assert.ok(material);
    const page = JSON.parse(material.text);

    assert.equal(page.sourceHash, contentHashOf(original));
    assert.deepEqual(page.coordinate, { runId: "normal", sequence: 2 });
    assert.equal(page.complete, false);
    assert.ok(readCentralMaterialPageRef(page.nextRef));
    assert.equal(await source.owns(f.ctx.cwd, page.nextRef), true);
    await assert.rejects(source.read(f.ctx.cwd, [page.nextRef], 512, signal), /central_material_capacity/u);
    const continuation = await source.read(f.ctx.cwd, [page.nextRef], PAGE_ENVELOPE_CHARS, signal);

    assertEnvelopeBudget(continuation, PAGE_ENVELOPE_CHARS);
    const next = JSON.parse(continuation[0]!.text);

    assert.equal(next.start, page.end);
    assert.equal(next.text, original.slice(next.start, next.end));
    assert.equal(next.sourceHash, page.sourceHash);
    const fresh = createCentralRuntimeMaterials({ ...f, enabled: () => true });

    assert.deepEqual(await fresh.read(f.ctx.cwd, [page.nextRef], PAGE_ENVELOPE_CHARS, signal), continuation);
    assert.equal(readdirSync(sessionsDir(f.ctx.homeDir, f.ctx.env)).some(name => name.includes(".lock")), true,
      "the original active writer remains untouched by all source reads");
  } finally { await store.release(); }
});

test("business capability leaves canonical issue opportunities to their owner while retaining exact original catalog reads", async () => {
  const f = fixture(), store = await session(f.ctx, "issue-source", f.workspaceId, "The actual original request asks for an interface counterexample.");
  try {
    const written = await withBoardWriter(methodBoardRoot(f.ctx.homeDir, f.ctx.env), async board => board.apply({
      type: "coordinate_learning", commandId: "report-materials", issuedAt: at, action: { kind: "report", scope: f.ctx.cwd,
        problemKey: "Original interface counterexample", issueId: "issue-materials", report: { reportId: "report-materials",
          source: { subsystem: "skill", taskId: "turn-issue-source", versionId: "issue-source" },
          facts: ["An original interface counterexample remains unresolved."],
          evidenceRefs: [sessionContentAddress({ sessionId: "issue-source", journalSequence: 2 })] } } }));

    assert.ok(written.ok);
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true });
    const snapshot = await source.snapshot(f.ctx.cwd, signal);

    assert.deepEqual(snapshot.opportunities, []);
    assert.ok(snapshot.materials.some(item => item.text.includes("actual original request")));
    const issue = written.state.learningIssues?.find(row => row.issueId === "issue-materials");
    assert.ok(issue);
    const catalog = sessionSourceAddressCatalogForIssue(issue, written.state);
    const pages = await source.read(f.ctx.cwd, [catalog.ref], CATALOG_ENVELOPE_CHARS, signal);

    assertEnvelopeBudget(pages, CATALOG_ENVELOPE_CHARS);
    assert.ok(pages.some(item => item.text.includes("full_canonical_issue_source_address_catalog")));
    assert.equal(snapshot.sourceRefs.includes(catalog.ref), false, "report/catalog change detection belongs to the canonical issue source");
    const business = await source.businessSnapshot(f.ctx.cwd, signal);

    assert.deepEqual(business, { materials: snapshot.materials, sourceRefs: snapshot.sourceRefs, hasMore: snapshot.hasMore });
    const directory = snapshot.materials.find(item => JSON.parse(item.text).role === "host_normal_turn_source_catalog_not_read_body");
    assert.ok(directory);
    assert.equal(snapshot.sourceRefs.includes(directory.ref), false, "host catalog hashes do not introduce new business facts");
    assert.equal(await source.owns(f.ctx.cwd, directory.ref), true);
    await assert.rejects(source.read(f.ctx.cwd, [directory.ref], 128, signal), /central_material_capacity/u);
    const directoryPage = await source.read(f.ctx.cwd, [directory.ref], CATALOG_ENVELOPE_CHARS, signal);

    assertEnvelopeBudget(directoryPage, CATALOG_ENVELOPE_CHARS);
    assert.equal(JSON.parse(directoryPage[0]!.text).sourceHash, contentHashOf(directory.text));
    assert.ok(directory.sourceRefs.every(ref => directoryPage[0]!.sourceRefs.includes(ref)));
    const original = await source.pageReader.read(sessionContentAddress({ sessionId: "issue-source", journalSequence: 2 }), signal, 0, 2048);

    assert.ok(original.ok);
    assert.equal(original.value.coordinate.sequence, 2);
    assert.equal(snapshot.sourceRefs.some(ref => /^board-sequence:/u.test(ref)), false);
  } finally { await store.release(); }
});

test("learning-only turns, foreign workspaces, hidden reasoning and literal secrets cannot enter business materials", async () => {
  const f = fixture(), secret = "literal-secret-material-test", normal = await session(f.ctx, "business", f.workspaceId, `Business requirement ${secret}`);
  const hidden = await session(f.ctx, "learning-only", f.workspaceId, "LEARNING_ONLY_SYNTHETIC_REQUIREMENT", true);
  const foreign = await session(f.ctx, "foreign", "another-workspace", "FOREIGN_WORKSPACE_PRIVATE_TEXT");

  try {
    assert.ok((await normal.append({ type: "transcript_item", sessionId: "business", turnId: "turn-business", at,
      payload: { kind: "assistant_reasoning", sequence: 1, blockId: "hidden", text: "HIDDEN_REASONING_TEXT", redacted: false } })).ok);
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true, secrets: [secret] });
    const snapshot = await source.snapshot(f.ctx.cwd, signal), serialized = JSON.stringify(snapshot);

    for (const excluded of [secret, "LEARNING_ONLY_SYNTHETIC_REQUIREMENT", "FOREIGN_WORKSPACE_PRIVATE_TEXT", "HIDDEN_REASONING_TEXT"]) {
      assert.equal(serialized.includes(excluded), false, excluded);
    }

    assert.ok(serialized.includes("Business requirement"));
    await assert.rejects(source.read(f.ctx.cwd, [sessionContentAddress({ sessionId: "foreign", journalSequence: 2 })], 1024, signal), /scope/u);
    await assert.rejects(source.read(f.ctx.cwd, [sessionContentAddress({ sessionId: "learning-only", journalSequence: 2 })], 1024, signal), /unavailable|scope/u);
  } finally {
    await normal.release();
    await hidden.release();
    await foreign.release();
  }
});

test("each snapshot observes the current original journal prefix and respects disabled, cancellation and scope boundaries", async () => {
  const f = fixture(), store = await session(f.ctx, "updates", f.workspaceId, "First actual requirement.");
  let enabled = true;

  try {
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => enabled });
    const before = await source.snapshot(f.ctx.cwd, signal);

    assert.ok((await store.append({ type: "turn_input", sessionId: "updates", turnId: "turn-next", at, payload: { text: "New actual requirement." } })).ok);
    const after = await source.snapshot(f.ctx.cwd, signal);

    assert.ok(JSON.stringify(after.materials).includes("New actual requirement"));
    assert.notDeepEqual(after.sourceRefs, before.sourceRefs);
    const unrelated = await withBoardWriter(methodBoardRoot(f.ctx.homeDir, f.ctx.env), async board => board.apply({
      type: "record_reward_v2_fact", commandId: "unrelated-source-metadata", issuedAt: at, expectedSequence: after.boardSequence,
      fact: { id: "unrelated-metadata-fact", scope: "another-scope", algorithmVersion: "unrelated-control-metadata-v1",
        kind: "projection", payloadJson: "{}" } }));
    assert.ok(unrelated.ok);
    const unrelatedSnapshot = await source.snapshot(f.ctx.cwd, signal);

    assert.ok(unrelatedSnapshot.boardSequence > after.boardSequence);
    assert.deepEqual(unrelatedSnapshot.sourceRefs, after.sourceRefs, "global Board writes and derived recall hashes are not new business source facts");
    assert.ok((await store.append({ type: "turn_start", sessionId: "updates", turnId: "learning-after-business", at,
      payload: { userSourceAvailable: false } })).ok);

    for (let sequence = 0; sequence < 33; sequence++) assert.ok((await store.append({ type: "turn_input", sessionId: "updates",
      turnId: "learning-after-business", at, payload: { text: `Synthetic coordination input ${sequence}` } })).ok);

    const afterManagement = await source.snapshot(f.ctx.cwd, signal);

    assert.deepEqual(afterManagement.sourceRefs, after.sourceRefs, "learning-only appended records cannot move the business catalog or wake the learner");
    enabled = false;
    await assert.rejects(source.snapshot(f.ctx.cwd, signal), /disabled|cancelled/u);
    enabled = true;
    const cancel = new AbortController();
    cancel.abort();
    await assert.rejects(source.snapshot(f.ctx.cwd, cancel.signal), /cancelled/u);
    await assert.rejects(source.snapshot(`${f.ctx.cwd}-foreign`, signal), /scope/u);
  } finally { await store.release(); }
});

test("purpose-related prior knowledge comes from the original Board and its cited original source remains page-readable", async () => {
  const f = fixture(), original = "Ownership contract review requires checking the original writer before changing the handoff.";
  const store = await session(f.ctx, "knowledge-task", f.workspaceId, "Review the ownership contract and original writer.");

  try {
    const packet = buildContentPacket({ scope: f.ctx.cwd, domain: "tool", boardSequence: 0, records: [
      { ref: "original-ownership-rule", runId: "original-knowledge-owner", sequence: 7, scope: f.ctx.cwd, origin: "user_statement", text: original },
    ], materials: [], requirements: [], answers: [] });
    assert.ok(packet.ok);
    const compiled = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "ownership-rule",
      statement: "Check the original writer before changing ownership handoffs.", conditions: "Ownership contract review only.",
      citations: [{ evidenceRef: "original-ownership-rule", quote: original }] }], applications: [], relations: [], preparations: [] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "No new semantic equivalence is certified.", citations: [] } }));
    assert.ok(compiled.ok);
    const saved = await withBoardWriter(methodBoardRoot(f.ctx.homeDir, f.ctx.env), async board => board.apply({
      type: "record_reward_v2_fact", commandId: "original-knowledge-fact", issuedAt: at, expectedSequence: 0,
      fact: buildContentRecord(packet.value, compiled.value) }));
    assert.ok(saved.ok);
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true });
    const snapshot = await source.snapshot(f.ctx.cwd, signal);

    assert.equal(snapshot.materials.some(item => item.kind === "knowledge"), false, "only an explicit relevant knowledge read invokes recall");
    const query = centralKnowledgeQueryRef("ownership contract");

    assert.equal(await source.owns(f.ctx.cwd, query), true);
    const recalled = await source.read(f.ctx.cwd, [query], 32768, signal);

    assert.ok(recalled.some(item => item.kind === "knowledge" && item.text.includes("Check the original writer")));
    assert.equal(await source.owns(f.ctx.cwd, "original-ownership-rule"), false, "opaque ownership is not guessed from an unadvertised citation");
    assert.equal(await source.owns(f.ctx.cwd, "a-user-peer-ref-with-no-original-source"), false);
    assert.equal(await source.owns(f.ctx.cwd, centralMaterialPageRef("a-user-peer-ref-with-no-original-source", 0)), false);
    await assert.rejects(source.read(f.ctx.cwd, ["original-ownership-rule"], 512, signal), /central_material_capacity/u);
    const read = await source.read(f.ctx.cwd, ["original-ownership-rule"], PAGE_ENVELOPE_CHARS, signal), page = JSON.parse(read[0]!.text);

    assertEnvelopeBudget(read, PAGE_ENVELOPE_CHARS);
    assert.equal(await source.owns(f.ctx.cwd, "original-ownership-rule"), true, "a returned exact original source is now advertised");
    assert.equal(page.text, original);
    assert.equal(page.sourceHash, contentHashOf(original));
    assert.deepEqual(page.coordinate, { runId: "original-knowledge-owner", sequence: 7 });
  } finally { await store.release(); }
});

test("one busy-session wake discovers every unconsumed normal turn across bounded restart batches", async () => {
  const f = fixture(), store = await session(f.ctx, "busy", f.workspaceId, "Actual business A before the learner became free.");
  try {
    for (const letter of "BCDEFGHIJK") assert.ok((await store.append({ type: "turn_input", sessionId: "busy", turnId: `turn-${letter}`, at,
      payload: { text: `Actual business ${letter} arrived during the same busy interval.` } })).ok);

    const first = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal);
    const directories = first.materials.map(row => JSON.parse(row.text)).filter(row => row.role === "host_normal_turn_source_catalog_not_read_body");

    assert.equal(directories.length, 8);
    assert.equal(first.hasMore, true);
    assert.deepEqual(directories.slice(0, 3).map(row => row.turnId), ["turn-busy", "turn-B", "turn-C"]);
    const second = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: first.sourceRefs });
    const remaining = second.materials.map(row => JSON.parse(row.text)).filter(row => row.role === "host_normal_turn_source_catalog_not_read_body");

    assert.deepEqual(remaining.map(row => row.turnId), ["turn-I", "turn-J", "turn-K"]);
    assert.equal(second.hasMore, false);
    const drained = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: [...first.sourceRefs, ...second.sourceRefs] });

    assert.deepEqual(drained.materials, []);
    assert.equal(drained.hasMore, false);
    const notices = [...first.sourceRefs, ...second.sourceRefs].filter(ref => ref.startsWith("central-business-turn:"));

    assert.equal(new Set(notices).size, 11, "only the canonical caller's source refs advance the read-only discovery boundary");
  } finally { await store.release(); }
});

test("complete catalog entries stay readable while snapshot consumption advances only source-owned turn notices", async () => {
  const f = fixture(), store = await session(f.ctx, "position-catalogs", f.workspaceId, "Original business requirement for position catalog zero.");
  try {
    for (let turn = 0; turn < 9; turn++) {
      const turnId = turn === 0 ? "turn-position-catalogs" : `position-turn-${turn}`;
      if (turn !== 0) assert.ok((await store.append({ type: "turn_input", sessionId: "position-catalogs", turnId, at,
        payload: { text: `Original business requirement for position catalog ${turn}.` } })).ok);
      for (let item = 0; item < 8; item++) assert.ok((await store.append({ type: "transcript_item", sessionId: "position-catalogs", turnId, at,
        payload: { kind: "tool_result", sequence: turn * 8 + item, toolCallId: `business-${turn}-${item}`, name: "read_file",
          output: `Complete original business body ${turn}/${item}.`, outcome: "succeeded", truncated: false } })).ok);
    }

    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true }), first = await source.snapshot(f.ctx.cwd, signal);
    const catalogs = first.materials.filter(row => JSON.parse(row.text).role === "host_normal_turn_source_catalog_not_read_body");
    const pages = first.materials.filter(row => JSON.parse(row.text).role === "actual_source_fragment_not_full_source");
    const directories = catalogs.map(row => JSON.parse(row.text));

    assert.equal(directories.length, 8);
    assert.equal(first.hasMore, true);
    assert.ok(pages.length > 0);
    assertEnvelopeBudget(pages, 2048);
    assert.ok(directories.every(row => row.entries.length === 8), "snapshot material bodies retain every bounded original catalog entry");
    const expected = [...new Set([...pages.flatMap(row => [row.ref, ...row.sourceRefs]), ...directories.map(row => row.noticeRef)])];

    assert.deepEqual(first.sourceRefs, expected, "catalog citations are available material, not additional consumed positions");

    for (const [index, directory] of directories.entries()) for (const entry of directory.entries) {
      assert.ok(catalogs[index]!.sourceRefs.includes(entry.ref));
      assert.ok(catalogs[index]!.sourceRefs.includes(entry.address));
      assert.equal(first.sourceRefs.includes(entry.ref), false);
      assert.equal(first.sourceRefs.includes(entry.address), false);
    }

    const entry = directories[0]!.entries[0];
    assert.equal(await source.owns(f.ctx.cwd, entry.ref), true);
    await assert.rejects(source.read(f.ctx.cwd, [entry.address], 512, signal), /central_material_capacity/u);
    const read = await source.read(f.ctx.cwd, [entry.address], PAGE_ENVELOPE_CHARS, signal), page = JSON.parse(read[0]!.text);

    assertEnvelopeBudget(read, PAGE_ENVELOPE_CHARS);
    assert.equal(page.text, entry.preview);
    assert.equal(page.coordinate.sequence, entry.journalSequence);
    const second = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: first.sourceRefs });
    const remaining = second.materials.map(row => JSON.parse(row.text)).filter(row => row.role === "host_normal_turn_source_catalog_not_read_body");

    assert.deepEqual(remaining.map(row => row.turnId), ["position-turn-8"]);
    assert.equal(second.hasMore, false);
    assert.equal(second.sourceRefs.length, 3);
    const drained = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: [...first.sourceRefs, ...second.sourceRefs] });

    assert.deepEqual(drained.materials, []);
    assert.equal(drained.hasMore, false);
  } finally { await store.release(); }
});

test("more than sixteen newer foreign sessions cannot hide the local workspace or require decoding foreign bodies", async () => {
  const f = fixture(), local = await session(f.ctx, "local-older", f.workspaceId, "LOCAL_WORKSPACE_SOURCE_SURVIVES_FOREIGN_TRAFFIC");
  try {
    utimesSync(sessionPath(f.ctx.homeDir, f.ctx.env, "local-older"), 1, 1);

    for (let index = 0; index < 20; index++) {
      const id = `foreign-${String(index).padStart(2, "0")}`, foreign = await session(f.ctx, id, "another-workspace", "FOREIGN_PRIVATE_BODY");
      await foreign.release();
      const file = sessionPath(f.ctx.homeDir, f.ctx.env, id), first = readFileSync(file, "utf8").split("\n")[0]!;
      writeFileSync(file, `${first}\nnot-a-valid-original-journal-record\n${"foreign-private-payload ".repeat(6000)}`);
      utimesSync(file, 100 + index, 100 + index);
    }

    const snapshot = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal);

    assert.ok(JSON.stringify(snapshot.materials).includes("LOCAL_WORKSPACE_SOURCE_SURVIVES_FOREIGN_TRAFFIC"));
    assert.equal(JSON.stringify(snapshot).includes("FOREIGN_PRIVATE_BODY"), false);
  } finally { await local.release(); }
});

test("purpose reconsideration follows only decoded original session context and genuinely new human inputs", async () => {
  const f = fixture(), original = await session(f.ctx, "purpose", f.workspaceId, "Original purpose requirement A.");
  const other = await session(f.ctx, "other-context", f.workspaceId, "Another original session context.");

  try {
    const before = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal);
    const subject = { plane: "central" as const, questionRef: "purpose:A" }, taskSubject = { plane: "central" as const, questionRef: "purpose:task-A" };
    const purposes = [{ subject, sourceRefs: [centralMaterialPageRef(sessionContentAddress({ sessionId: "purpose", journalSequence: 2 }), 0)] },
      { subject: taskSubject, sourceRefs: [sessionTaskAddress("turn-purpose")] },
      { subject: { plane: "central" as const, questionRef: "opaque:unknown" }, sourceRefs: ["opaque-material-without-a-session-address"] }];

    assert.ok((await original.append({ type: "transcript_item", sessionId: "purpose", turnId: "turn-purpose", at,
      payload: { kind: "tool_result", sequence: 1, toolCallId: "ordinary-tool", name: "read_file", output: "New tool tick only.", truncated: false, outcome: "succeeded" } })).ok);
    const toolTick = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: before.sourceRefs, purposes });

    assert.deepEqual(toolTick.reconsider ?? [], [], "tool ticks and notice hashes are not new human requirements");
    const added = await original.append({ type: "turn_input", sessionId: "purpose", turnId: "purpose-next", at,
      payload: { text: "The original user changed the requirement to B." } });
    assert.ok(added.ok);
    assert.ok((await other.append({ type: "turn_input", sessionId: "other-context", turnId: "other-next", at,
      payload: { text: "A different session changed an unrelated requirement." } })).ok);
    const updated = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: before.sourceRefs, purposes });
    const expectedRef = sessionContentAddress({ sessionId: "purpose", journalSequence: added.sequence });

    assert.deepEqual(updated.reconsider, [subject, taskSubject].map(value => ({ subject: value, sourceRefs: [expectedRef], reason: "original_user_context_changed" })));
    const consumed = await createCentralRuntimeMaterials({ ...f, enabled: () => true }).snapshot(f.ctx.cwd, signal,
      { subjects: [], sourceRefs: [...before.sourceRefs, ...updated.sourceRefs, ...updated.reconsider!.flatMap(change => change.sourceRefs)], purposes });

    assert.deepEqual(consumed.reconsider ?? [], [], "explicitly consumed original human refs are not new context on a repeated wake");
  } finally {
    await original.release();
    await other.release();
  }
});

test("advertised raw journal refs from distinct local session directories retain their original page owner", async () => {
  const f = fixture(), left = await session(f.ctx, "left-context", f.workspaceId, "Actual left session body.");
  const right = await session(f.ctx, "right-context", f.workspaceId, "Actual right session body.");

  try {
    const source = createCentralRuntimeMaterials({ ...f, enabled: () => true }), snapshot = await source.snapshot(f.ctx.cwd, signal);
    const entries = snapshot.materials.map(row => JSON.parse(row.text)).filter(row => row.role === "host_normal_turn_source_catalog_not_read_body")
      .flatMap(row => row.entries).filter(row => row.role === "turn_input");

    assert.equal(entries.length, 2);

    for (const entry of entries) {
      assert.equal(await source.owns(f.ctx.cwd, entry.ref), true);
      await assert.rejects(source.read(f.ctx.cwd, [entry.ref], 512, signal), /central_material_capacity/u);
      const read = await source.read(f.ctx.cwd, [entry.ref], PAGE_ENVELOPE_CHARS, signal), page = JSON.parse(read[0]!.text);
      assertEnvelopeBudget(read, PAGE_ENVELOPE_CHARS);
      assert.equal(page.text, entry.preview);
      assert.equal(page.coordinate.sequence, entry.journalSequence);
    }
  } finally {
    await left.release();
    await right.release();
  }
});

test("mounted learning controls cannot create raw business notices while real business and skill-view executions remain readable", async () => {
  const f = fixture(), store = await session(f.ctx, "control-units", f.workspaceId, "Original business requirement before learning controls.");
  const source = createCentralRuntimeMaterials({ ...f, enabled: () => true });
  let sequence = 0;
  const appendTool = async (name: string, output: string) => {
    const toolCallId = `real-call-${++sequence}`;
    const event = (kind: "tool_use" | "tool_result", payload: Record<string, string>) => ({ protocolVersion: "0.0", eventId: `${toolCallId}:${kind}`,
      sequence, timestamp: at, sessionId: "control-units", turnId: "turn-control-units", attemptId: "original-attempt",
      producerId: "loop", producerSequence: sequence, kind, payload });

    for (const row of [
      { type: "transcript_item" as const, payload: { kind: "tool_call", sequence, toolCallId, name, arguments: { purpose: output } } },
      { type: "envelope" as const, payload: { envelope: event("tool_use", { name, toolCallId }) } },
      { type: "transcript_item" as const, payload: { kind: "tool_result", sequence, toolCallId, name, output, truncated: false, outcome: "succeeded" } },
    ]) assert.ok((await store.append({ ...row, sessionId: "control-units", turnId: "turn-control-units", at })).ok);

    const result = await store.append({ type: "envelope", sessionId: "control-units", turnId: "turn-control-units", at,
      payload: { envelope: event("tool_result", { toolCallId, status: "succeeded", output }) } });
    assert.ok(result.ok);

    return sessionContentAddress({ sessionId: "control-units", journalSequence: result.sequence });
  };

  try {
    const before = await source.snapshot(f.ctx.cwd, signal), blocked: string[] = [];

    for (const name of ["method_context", "skill_proposals", "workflow_learning", "tool_learning_report"]) {
      blocked.push(await appendTool(name, `INTERNAL_LEARNING_CONTROL_RESULT:${name}`));
    }

    const controlled = await source.snapshot(f.ctx.cwd, signal);

    assert.deepEqual(controlled.sourceRefs, before.sourceRefs, "learning control transcript/envelope units are not new business facts");
    assert.equal(JSON.stringify(controlled.materials).includes("INTERNAL_LEARNING_CONTROL_RESULT"), false);

    for (const ref of blocked) await assert.rejects(source.read(f.ctx.cwd, [ref], 512, signal), /missing/u);

    for (const name of ["read_file", "run_shell", "skill_view", "mcp__trylo-hermes-skills__skill_view"]) {
      const output = `REAL_BUSINESS_OR_SKILL_USE:${name}`, ref = await appendTool(name, output);
      const read = await source.read(f.ctx.cwd, [ref], 1024, signal);
      assert.ok(read.some(material => material.text.includes(output)));
    }

    const used = await source.snapshot(f.ctx.cwd, signal);

    assert.notDeepEqual(used.sourceRefs, before.sourceRefs);
  } finally { await store.release(); }
});
