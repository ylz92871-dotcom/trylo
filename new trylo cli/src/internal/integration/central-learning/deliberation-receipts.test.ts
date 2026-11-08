import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRewardV2BoardPort, RewardV2BoardError } from "../reward/v2-board-port.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { createCentralDeliberationReceiptsAtRoot, isCentralDeliberationReceiptRequest, readCentralDeliberationReceiptFailure,
  readCentralDeliberationDeliveriesFromFacts } from "./deliberation-receipts.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { isCentralThoughtMaxTokens } from "../../learning/central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { centralDeliberationReservation, decodeCentralDeliberation } from "./deliberation-prompt.js";
import { buildCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";
import { activePurposeAgendaVersion } from "./active-purpose-delivery.js";

const SCOPE = "project:central-receipts", BUDGET = "budget:receipts";
const request = (): CentralDeliberationRequest => ({ schemaVersion: 1, scope: SCOPE, budgetId: BUDGET, boardSequence: 0,
  resources: { boardSequence: 0, budgetId: BUDGET, limits: { tokens: 100000, calls: 4, steps: 4 },
    occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
  configuration: { schemaVersion: 1, configurationRef: "configuration:one", authorizationRef: "authorization:one",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
  stateRef: "state:one", state: { schemaVersion: 1, scope: SCOPE, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
  opportunities: [], materials: [{ ref: "source:one", kind: "source", text: "Actual public source.", sourceRefs: ["source:one"] }], organization: [],
  operation: { kind: "think", operationId: "operation:one", purpose: "Choose useful research.", expectedChange: "Resolve next step.", sourceRefs: ["source:one"] } });
const output = (): CentralDeliberationOutput => ({ schemaVersion: 1, intents: [], publicExplanation: "Wait for actual use.", sourceRefs: ["source:one"] });

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "trylo-central-delivery-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function options(boardRoot: string) { return { boardRoot, scope: SCOPE, budgetId: BUDGET, enabled: () => true }; }

test("read-only batch receipt lookup shares the original chunk validation and needs no current budget configuration", async () => withRoot(async root => {
  const saved = await createCentralDeliberationReceiptsAtRoot(options(root)).save({ request: request(), output: output() });
  const prefix = await createRewardV2BoardPort(root, () => true).read(), original = JSON.stringify(prefix);
  const read = readCentralDeliberationDeliveriesFromFacts(prefix.facts, SCOPE, prefix.revision, [saved.deliveryRef, "delivery:missing"]);

  assert.deepEqual(read, [saved, undefined]);
  assert.equal(JSON.stringify(prefix), original, "reading original receipts changes no Board bytes");
  assert.throws(() => readCentralDeliberationDeliveriesFromFacts(prefix.facts, "project:another", prefix.revision, [saved.deliveryRef]),
    /central_deliberation_receipt_corrupt/);
  const changed = prefix.facts.map((fact, index) => index === 0 ? { ...fact,
    payloadJson: fact.payloadJson.replace("Actual public source.", "Edited public source.") } : fact);

  assert.throws(() => readCentralDeliberationDeliveriesFromFacts(changed, SCOPE, prefix.revision, [saved.deliveryRef]),
    /central_deliberation_receipt_corrupt/);
}));

test("independent thought token ceiling is optional, bounded and preserved in the original delivery", async () => withRoot(async root => {
  const store = createCentralDeliberationReceiptsAtRoot(options(root)), legacy = request();

  assert.ok(isCentralDeliberationReceiptRequest(legacy));
  const explicit = { ...request(), configuration: { ...legacy.configuration, thoughtMaxTokens: 32000 },
    operation: { ...legacy.operation, operationId: "operation:independent-thought" } };

  assert.ok(isCentralDeliberationReceiptRequest(explicit));

  for (const value of [1, 32000, 1_000_000_000]) {
    assert.ok(isCentralThoughtMaxTokens(value));
    assert.ok(isCentralDeliberationReceiptRequest({ ...legacy, configuration: { ...legacy.configuration, thoughtMaxTokens: value } }));
  }

  for (const value of [undefined, null, 0, -1, 1.5, 1_000_000_001, Number.MAX_SAFE_INTEGER, NaN, Infinity, "32000", true]) {
    assert.equal(isCentralThoughtMaxTokens(value), false);
    assert.equal(isCentralDeliberationReceiptRequest({ ...legacy, configuration: { ...legacy.configuration, thoughtMaxTokens: value } }), false);
  }

  await store.save({ request: legacy, output: output() });
  await store.save({ request: explicit, output: output() });
  const restarted = createCentralDeliberationReceiptsAtRoot(options(root));

  assert.deepEqual((await restarted.read(legacy.operation.operationId))?.request.configuration, legacy.configuration);
  assert.deepEqual((await restarted.read(explicit.operation.operationId))?.request.configuration, explicit.configuration);
  assert.equal(Object.hasOwn((await restarted.read(legacy.operation.operationId))!.request.configuration, "thoughtMaxTokens"), false);
  assert.deepEqual(explicit.configuration.allowance, legacy.configuration.allowance);
}));

test("original Board delivery persists across adapter restart and same operation is immutable/idempotent", async () => withRoot(async root => {
  const first = createCentralDeliberationReceiptsAtRoot(options(root));

  assert.equal(await first.read("operation:one"), undefined);
  const expected = { request: request(), output: output() }, saved = await first.save(expected);

  assert.deepEqual(saved.request, expected.request);
  assert.deepEqual(saved.output, expected.output);
  const board = createRewardV2BoardPort(root, () => true), before = await board.read();
  const restarted = createCentralDeliberationReceiptsAtRoot(options(root));

  assert.deepEqual(await restarted.read("operation:one"), saved);
  assert.deepEqual(await restarted.save(expected), saved);
  assert.equal((await board.read()).revision, before.revision);
  await assert.rejects(restarted.save({ ...expected, output: { ...expected.output, publicExplanation: "Different response under the same request." } }), /conflict/);
  assert.deepEqual(await restarted.read("operation:one"), saved);
}));

test("optional active-purpose delivery metadata survives an original Board receipt without rewriting canonical state or legacy absence", async () => withRoot(async root => {
  const legacy = request(), store = createCentralDeliberationReceiptsAtRoot(options(root));
  const explicit: CentralDeliberationRequest = { ...legacy,
    operation: { ...legacy.operation, operationId: "operation:active-purpose-delivery" },
    activePurposeDelivery: { version: "active-purpose-navigation-v1", agendaVersion: activePurposeAgendaVersion(legacy.state.intents), maximumEntries: 1 } };

  assert.equal(legacy.state.intents.length, 0, "an empty original agenda still has a valid owner-derived version");
  assert.ok(isCentralDeliberationReceiptRequest(explicit));
  const originalState = canonicalJson(legacy.state), originalMaterials = canonicalJson(legacy.materials);

  await store.save({ request: legacy, output: output() });
  const saved = await store.save({ request: explicit, output: output() });
  const fresh = createCentralDeliberationReceiptsAtRoot(options(root)), read = await fresh.read(explicit.operation.operationId);
  assert.ok(read);
  assert.deepEqual(read, saved);
  assert.deepEqual(read.request.activePurposeDelivery, explicit.activePurposeDelivery);
  assert.equal(canonicalJson(read.request.state), originalState);
  assert.equal(canonicalJson(read.request.materials), originalMaterials);
  assert.deepEqual(read.request.operation.sourceRefs, legacy.operation.sourceRefs);
  assert.deepEqual(read.sourceRefs, [saved.deliveryRef]);
  assert.equal(canonicalJson(legacy.state), originalState);
  assert.equal(canonicalJson(legacy.materials), originalMaterials);
  const old = await fresh.read(legacy.operation.operationId);
  assert.ok(old);
  assert.equal(Object.hasOwn(old.request, "activePurposeDelivery"), false, "old receipts acquire no default metadata");
  const board = createRewardV2BoardPort(root, () => true), before = await board.read();

  await assert.rejects(fresh.save({ request: { ...legacy, operation: explicit.operation }, output: output() }), /central_deliberation_receipt_conflict/);
  assert.equal((await board.read()).revision, before.revision);
  assert.deepEqual(await fresh.read(explicit.operation.operationId), saved);
}));

test("whole public payload spans original Board facts and corruption fails closed", async () => withRoot(async root => {
  const long = request(), repeated = "Source-bound public observation. ".repeat(900);
  const expanded = { ...long, materials: Array.from({ length: 7 }, (_value, index) => ({ ref: `source:${index}`, kind: "source" as const,
    text: repeated, sourceRefs: [`source:${index}`] })) };
  const store = createCentralDeliberationReceiptsAtRoot(options(root));
  const saved = await store.save({ request: expanded, output: output() });

  assert.ok(JSON.stringify(saved).length > 131072);
  const board = createRewardV2BoardPort(root, () => true), snapshot = await board.read();

  assert.ok(snapshot.facts.length > 2);
  assert.ok(snapshot.facts.every(fact => fact.payloadJson.length <= 131072));
  const corrupt = { ...snapshot, facts: snapshot.facts.map((fact, index) => index === 0 ? { ...fact, payloadJson: "{}" } : fact) };
  const reader = createCentralDeliberationReceiptsAtRoot({ ...options(root), board: { read: async () => corrupt, append: board.append } });

  await assert.rejects(reader.read("operation:one"), /corrupt/);
}));

test("unknown manifest append can be read back without a new append; different root/scope and secrets are refused", async () => withRoot(async root => {
  const board = createRewardV2BoardPort(root, () => true);
  let writes = 0;
  const unreliable = { read: board.read, append: async (...args: Parameters<typeof board.append>) => {
    const value = await board.append(...args);
    writes += 1;
    if (args[1].algorithmVersion === "central-deliberation-delivery-v1") throw new Error("lost append acknowledgement");
    return value;
  } };
  const store = createCentralDeliberationReceiptsAtRoot({ ...options(root), board: unreliable });
  const confirmed = await store.save({ request: request(), output: output() });
  const before = writes, recovered = await store.read("operation:one");
  assert.ok(recovered);
  assert.deepEqual(recovered, confirmed, "exact durable readback confirms the lost acknowledgement");
  assert.equal(writes, before);
  assert.equal(await createCentralDeliberationReceiptsAtRoot({ ...options(root), budgetId: "budget:other" }).read("operation:one"), undefined);
  const secret = createCentralDeliberationReceiptsAtRoot({ ...options(root), secrets: ["sensitive-literal"] });

  await assert.rejects(secret.save({ request: request(), output: { ...output(), publicExplanation: "sensitive-literal" } }), /sensitive/);
  let reads = 0;
  const disabled = createCentralDeliberationReceiptsAtRoot({ ...options(root), enabled: () => false,
    board: { read: async () => {
      reads += 1;
      return board.read();
    }, append: board.append } });

  await assert.rejects(disabled.read("operation:one"), /collect_disabled/);
  assert.equal(reads, 0);
}));

test("uncommitted fragments are not returned and invalid request fields never create a delivery", async () => withRoot(async root => {
  const board = createRewardV2BoardPort(root, () => true);
  const interrupted = { read: board.read, append: async (...args: Parameters<typeof board.append>) => {
    if (args[1].algorithmVersion === "central-deliberation-delivery-v1") {
      throw Object.assign(new RewardV2BoardError("multi_writer"), { detail: "sensitive-literal" });
    }
    return board.append(...args);
  } };
  const store = createCentralDeliberationReceiptsAtRoot({ ...options(root), board: interrupted });

  await assert.rejects(store.save({ request: request(), output: output() }), error => {
    const failure = readCentralDeliberationReceiptFailure(error);

    assert.deepEqual(failure, { reason: "central_deliberation_receipt_write_unconfirmed", boardReason: "multi_writer" });
    const surfaced = new CentralDeliberationError("central_deliberation_response_write_unconfirmed", "unknown", "reservation:original", undefined, failure);

    assert.equal(surfaced.message, "central_deliberation_response_write_unconfirmed;receipt_reason=central_deliberation_receipt_write_unconfirmed;board_reason=multi_writer");
    assert.equal(surfaced.reason, "central_deliberation_response_write_unconfirmed");
    assert.equal(surfaced.delivery, "unknown");
    assert.equal(surfaced.reservationId, "reservation:original");
    assert.equal(surfaced.failureClass, "accounting");
    assert.doesNotMatch(JSON.stringify(surfaced), /sensitive-literal/);
    assert.deepEqual(readCentralDeliberationReceiptFailure(new Error("sensitive-literal")), { reason: "central_deliberation_receipt_unclassified" });

    return true;
  });
  assert.equal(await store.read("operation:one"), undefined);
  assert.ok((await board.read()).facts.length > 0);
  const fresh = createCentralDeliberationReceiptsAtRoot(options(root));
  const before = (await board.read()).revision;

  await assert.rejects(fresh.save({ request: { ...request(), scope: "project:other" }, output: output() }), /input_invalid/);
  assert.equal((await board.read()).revision, before);
}));

test("actual wire proof persists its exact source mapping and rejects a different checkpoint, output or wire", async () => withRoot(async root => {
  const original = request(), input = createCentralLearningChangeView(original);
  const source = input.dictionary.entries.find(entry => entry.kind === "source" && entry.ref === "source:one");
  assert.ok(source);
  const rawChange = { checkpoint: input.view.checkpoint, changes: [], explanation: "Wait for actual use.", sources: [source.handle] };
  const expanded = decodeCentralDeliberation(compileCentralLearningChange(rawChange, original, input.dictionary), original, []);
  const funding = { role: "user" as const, content: canonicalJson({ role: "host_original_root_after_this_computation_reservation",
    budgetId: BUDGET, limits: original.resources.limits, occupied: { tokens: 20000, calls: 1, steps: 1 },
    available: { tokens: 80000, calls: 3, steps: 3 }, status: "available", holdReason: null,
    thisComputation: { reservationId: centralDeliberationReservation(original), maxTokens: 20000, calls: 1, steps: 1 },
    interpretation: "current_root_resources_not_new_authorization_or_value_prediction" }) };
  const wire = { messages: [...input.messages, funding], maxOutputTokens: 8192, tools: [{ name: CENTRAL_LEARNING_CHANGE_TOOL,
    description: "Return only this public learning change.", parameters: centralLearningChangeSchema(original) }] };
  const proof = buildCentralDeliberationWireEvidence({ request: original, output: expanded, rawChange, wire });
  assert.ok(proof);
  assert.equal(proof.messagesHash, contentHashOf(wire.messages));
  assert.equal(proof.toolsHash, contentHashOf(wire.tools));
  assert.equal(proof.maxOutputTokens, 8192, "the actual output setting is not the reserved 20000 total-token allowance");
  assert.equal(proof.exposure.find(entry => entry.ref === "source:one")?.kind, "body");
  assert.ok(input.messages[1]?.content.includes("Actual public source."));
  assert.equal(JSON.stringify(proof).includes("Actual public source."), false, "the proof does not duplicate source bodies or the full prompt");
  assert.notEqual(funding.content, canonicalJson(original.resources), "capture the real post-reservation envelope, not the earlier resource quote");
  const store = createCentralDeliberationReceiptsAtRoot(options(root));
  const saved = await store.save({ request: original, output: expanded, wireEvidence: proof });

  assert.deepEqual(saved.wireEvidence, proof);
  assert.deepEqual(saved.request, original);
  assert.deepEqual(saved.output, expanded);
  assert.deepEqual(saved.sourceRefs, [saved.deliveryRef], "an exposure manifest does not create new independent observations");
  const board = createRewardV2BoardPort(root, () => true), prefix = await board.read();
  const restarted = createCentralDeliberationReceiptsAtRoot(options(root));

  assert.deepEqual(await restarted.read(original.operation.operationId), saved);
  assert.deepEqual(readCentralDeliberationDeliveriesFromFacts(prefix.facts, SCOPE, prefix.revision, [saved.deliveryRef]), [saved]);
  await assert.rejects(restarted.save({ request: original, output: expanded }), /conflict/, "same-operation proof cannot disappear on retry");
  await assert.rejects(restarted.save({ request: original, output: expanded, wireEvidence: { ...proof, dictionaryHash: "0".repeat(64) } }), /input_invalid/);
  assert.equal((await board.read()).revision, prefix.revision, "invalid evidence never appends fragments or another receipt");
  assert.equal(buildCentralDeliberationWireEvidence({ request: { ...original, stateRef: "state:another" }, output: expanded, rawChange, wire }), undefined);
  assert.equal(buildCentralDeliberationWireEvidence({ request: original, output: { ...expanded, publicExplanation: "Changed after delivery." }, rawChange, wire }), undefined);
  assert.equal(buildCentralDeliberationWireEvidence({ request: original, output: expanded, rawChange,
    wire: { ...wire, messages: [...input.messages, { role: "user", content: "Unproved extra source body." }, funding] } }), undefined);
  const structured = buildCentralDeliberationWireEvidence({ request: original, output: expanded, rawChange,
    wire: { messages: wire.messages, maxOutputTokens: 8192, tools: [], responseSchema: centralLearningChangeSchema(original) } });

  assert.ok(structured);
  assert.equal(structured.responseSchemaHash, contentHashOf(centralLearningChangeSchema(original)));
  const fundingBody = JSON.parse(funding.content) as Record<string, unknown>;
  const quote = { ...funding, content: canonicalJson({ ...fundingBody,
    occupied: { tokens: 1_000_000_000, calls: 1_000_000_000, steps: 1_000_000_000 },
    available: { tokens: 1_000_000_000, calls: 1_000_000_000, steps: 1_000_000_000 }, status: "exhausted",
    thisComputation: { reservationId: centralDeliberationReservation(original), maxTokens: 1_000_000_000, calls: 1, steps: 1 } }) };

  assert.equal(buildCentralDeliberationWireEvidence({ request: original, output: expanded, rawChange,
    wire: { ...wire, messages: [...input.messages, quote] } }), undefined, "the synthetic quote ceiling is not a consistent actual funding envelope");
  const beforeReservation = { ...funding, content: canonicalJson({ ...fundingBody,
    occupied: original.resources.occupied, available: original.resources.available }) };

  assert.equal(buildCentralDeliberationWireEvidence({ request: original, output: expanded, rawChange,
    wire: { ...wire, messages: [...input.messages, beforeReservation] } }), undefined, "the original pre-reservation balance cannot contain this reservation");
  const legacy = { ...original, operation: { ...original.operation, operationId: "operation:legacy-without-wire" } };
  const legacySaved = await store.save({ request: legacy, output: output() });

  assert.equal(Object.hasOwn(legacySaved, "wireEvidence"), false, "legacy payloads are not retroactively labeled as model exposure");
  assert.deepEqual(await restarted.read(legacy.operation.operationId), legacySaved);
}));
