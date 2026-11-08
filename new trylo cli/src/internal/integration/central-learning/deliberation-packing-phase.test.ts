import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CentralDeliberationDeliveryConstraints, CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { ProviderPort } from "../../ports/provider.js";
import { createCentralAccountingFunding } from "../learning-content/central-accounting-funding.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { centralDeliveredSourceRefs } from "./deliberation-context.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createOrganizationPublicationCondition } from "./organization-publication-material.js";
import { deliveredPublicationConditions } from "./runtime-publication-correction.js";
import { createCentralLearningDriver } from "./runtime-driver.js";

const scope = "workspace:packing-phase", sourceRef = "source:current-trigger", now = () => "2026-11-08T00:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 200000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 };
const material: CentralRuntimeMaterial = { ref: sourceRef, kind: "source", text: "The current host condition changed.", sourceRefs: [] };

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:packing", boardSequence: 1, stateRef: "state:packing",
    configuration: { schemaVersion: 1, configurationRef: "config:packing", authorizationRef: "auth:packing", allowance },
    resources: { boardSequence: 1, budgetId: "budget:packing", limits: { tokens: 200000, calls: 8, steps: 8 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 200000, calls: 8, steps: 8 }, status: "available", holdReason: null },
    state: emptyCentralRuntimeState(scope), opportunities: [], organization: [], materials: [material],
    operation: { kind: "think", operationId: "central-agenda:packing", purpose: "Review the changed condition.",
      expectedChange: "Choose whether any original work should continue.", sourceRefs: [sourceRef] } };
}

async function fixture() {
  let state = emptyBoardState(), reservations = 0, streams = 0;
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), async apply(command: BoardCommand) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };

  assert.ok((await board.apply({ type: "coordinate_learning", commandId: "open:packing", issuedAt: now(), action: {
    kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "budget:packing", scope,
      unit: "total_model_tokens", limits: { tokens: 200000, calls: 8, steps: 8 }, authorizationRef: "auth:packing" } } })).ok);
  const funding = createCentralAccountingFunding({ board, scope, budgetId: "budget:packing",
    owner: { kind: "central_deliberation", ownerId: "central:packing" }, now, enabled: () => true });
  const provider: ProviderPort = { async *stream() {
    streams++;
    throw new Error("No transport belongs in this test");
  },

    fork() { return { async *stream() {
      streams++;
      throw new Error("No transport belongs in this test");
    } }; } };
  const model = createCentralModelDeliberation({ provider, model: "fixture", funding: { ...funding,

    async reserve() {
      reservations++;
      return { ok: false, reason: "fixture_stop_before_reservation" };
    } } });

  return { model, funding, counts: () => ({ reservations, streams }) };
}

test("a plain fresh trigger may be assembled before final admission without losing its full body", async () => {
  const f = await fixture(), seen: string[] = [];
  const constraints: CentralDeliberationDeliveryConstraints = { sourceProgressFits(candidate, phase: "packing" | "admission" = "admission") {
    seen.push(phase);
    return phase === "packing" || centralDeliveredSourceRefs(candidate).includes(sourceRef);
  } };
  const input = request(), before = await f.funding.inspect();
  const prepared = await f.model.prepareDelivery!(input, new AbortController().signal, constraints);

  assert.ok(prepared.materials.some(row => canonicalJson(row) === canonicalJson(material)));
  assert.ok(seen.includes("packing"));
  assert.equal(seen.at(-1), "admission");
  assert.deepEqual(prepared.operation, input.operation);
  assert.deepEqual(prepared.configuration, input.configuration);
  assert.deepEqual(prepared.state.intents, input.state.intents);
  assert.equal(canonicalJson(prepared).includes("sourceProgressFits"), false);
  assert.deepEqual(await f.funding.inspect(), before);
  assert.deepEqual(f.counts(), { reservations: 0, streams: 0 });
});

test("prepareDelivery and deliberate both reject final missing fresh facts before reservation or transport", async () => {
  const f = await fixture(), input = { ...request(), materials: [] }, before = await f.funding.inspect();
  const constraints: CentralDeliberationDeliveryConstraints = { sourceProgressFits(candidate, phase: "packing" | "admission" = "admission") {
    return phase === "packing" || centralDeliveredSourceRefs(candidate).includes(sourceRef);
  } };

  await assert.rejects(f.model.prepareDelivery!(input, new AbortController().signal, constraints), /central_deliberation_context_capacity/);
  await assert.rejects(f.model.deliberate(input, new AbortController().signal, constraints), /central_deliberation_context_capacity/);
  assert.deepEqual(f.counts(), { reservations: 0, streams: 0 });
  assert.deepEqual(await f.funding.inspect(), before);
});

test("a selected publication condition still requires its complete applicable body at final admission", async () => {
  const f = await fixture(), condition = createOrganizationPublicationCondition(scope, { knowledgeId: "knowledge:prior",
    currentHeadFactId: `organization-record:${"a".repeat(64)}`, reason: "organization_knowledge_revision_conflict" });
  const input = { ...request(), materials: [condition], operation: { ...request().operation, sourceRefs: [condition.ref] } };
  const constraints: CentralDeliberationDeliveryConstraints = { sourceProgressFits(candidate, phase: "packing" | "admission" = "admission") {
    return phase === "packing" || deliveredPublicationConditions(candidate).some(row => canonicalJson(row) === canonicalJson(condition));
  } };
  const prepared = await f.model.prepareDelivery!(input, new AbortController().signal, constraints);

  assert.ok(deliveredPublicationConditions(prepared).some(row => canonicalJson(row) === canonicalJson(condition)));
  const missing = { ...input, materials: [], state: { ...input.state, materials: [{ ref: "central-semantic-attempt:fixture",
    kind: "work_result" as const, text: "An attempted operation names a source but does not deliver it.", sourceRefs: [condition.ref] }] } };

  await assert.rejects(f.model.prepareDelivery!(missing, new AbortController().signal, constraints), /central_deliberation_context_capacity/);
  assert.deepEqual(f.counts(), { reservations: 0, streams: 0 });
});

test("packing retains one-argument capacity callbacks and explicit thought ceilings", async () => {
  const f = await fixture(), before = await f.funding.inspect();
  let checks = 0;
  const constraints: CentralDeliberationDeliveryConstraints = { sourceProgressFits() {
    checks++;
    return false;
  } };

  await assert.rejects(f.model.prepareDelivery!(request(), new AbortController().signal, constraints), /central_deliberation_context_capacity/);
  assert.ok(checks > 0);
  const tiny = { ...request(), configuration: { ...request().configuration, thoughtMaxTokens: 256 } };

  await assert.rejects(f.model.deliberate(tiny, new AbortController().signal, { sourceProgressFits: () => true }), /central_deliberation_context_capacity/);
  assert.deepEqual(f.counts(), { reservations: 0, streams: 0 });
  assert.deepEqual(await f.funding.inspect(), before);
});

async function directory(t: TestContext) {
  const base = testScratchPath("central-packing-phase");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("driver packing keeps capacity while default and unknown phases still enforce final fresh delivery", async t => {
  let deliberations = 0, packingChecked = false;
  const driver = createCentralLearningDriver({ boardRoot: await directory(t), scope, enabled: () => true, now,
    source: { async snapshot() { return { boardSequence: 0, opportunities: [], sourceRefs: [sourceRef], materials: [material] }; },
      async read() { throw new Error("No source read requested"); } },
    execution: { async consult() { throw new Error("No consultation requested"); }, async prepare() { throw new Error("No dispatch requested"); },
      async execute() { throw new Error("No worker requested"); }, async recover() { return null; } },
    deliberation: { async prepareDelivery(input, _signal, constraints) {
      assert.ok(constraints);
      const missing = { ...input, opportunities: [], materials: [], organization: [], state: { ...input.state, materials: [] } };

      assert.equal(Reflect.apply(constraints.sourceProgressFits, constraints, [missing, "packing"]), true);
      assert.equal(constraints.sourceProgressFits(missing), false);
      assert.equal(Reflect.apply(constraints.sourceProgressFits, constraints, [missing, "unknown"]), false);
      const tooMany = { ...missing, materials: [
        { ...material, sourceRefs: Array.from({ length: 128 }, (_, index) => `source:capacity:${index}`) },
        { ...material, ref: "source:capacity-second", sourceRefs: Array.from({ length: 129 }, (_, index) => `source:capacity:${index + 128}`) },
      ] };

      assert.equal(Reflect.apply(constraints.sourceProgressFits, constraints, [tooMany, "packing"]), false);
      packingChecked = true;
      return missing;
    }, async deliberate() {
      deliberations++;
      throw new Error("Incomplete final delivery cannot run");
    } } });
  const result = await driver.drive({ scope, configuration: request().configuration,
    wake: { reason: "current_source_available", sourceRefs: [sourceRef] }, signal: new AbortController().signal, publish() {} });

  await driver.close?.();
  assert.equal(packingChecked, true, JSON.stringify(result));
  assert.equal(deliberations, 0);
  assert.equal(result.state, "waiting");
  assert.match(result.reason, /central_deliberation_source_progress_capacity/);
});
