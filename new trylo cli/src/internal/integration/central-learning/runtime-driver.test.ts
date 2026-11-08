import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { packCentralDeliberationContext } from "./deliberation-context.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralIssueSourceRefs } from "./runtime-source-issue-refs.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import type { CentralDeliberationOutput, CentralDeliberationPort, CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralLearningDriverProgress, CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeExecutionPort,
  CentralRuntimeMaterial, CentralRuntimeOrganizationPort, CentralRuntimeSnapshot, CentralRuntimeSourcePort, CentralRuntimeWorkResult } from "../../learning/central/runtime/contracts.js";

const scope = "workspace:central-driver", sourceRef = "report:original", issueId = "issue:original";
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "config:explicit",
  authorizationRef: "user:runtime-test", allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000,
    maxCalls: 16, maxSteps: 16, maxPromptChars: 10000 } };
const sourceMaterial: CentralRuntimeMaterial = { ref: sourceRef, kind: "source", text: "A real persisted condition differs from the old method.", sourceRefs: [] };
const now = () => "2026-11-05T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function operation(id: string, kind: "think" | "read" | "consult" | "dispatch"): CentralLearningOperation {
  const base = { operationId: id, purpose: "Resolve the missing condition", expectedChange: "Determine whether the method transfers", sourceRefs: [sourceRef] };
  if (kind === "read") return { ...base, kind, refs: [sourceRef], maximumChars: 2048 };
  if (kind === "consult" || kind === "dispatch") return { ...base, kind, allowance: { ...configuration.allowance, maxTokens: 100, maxCalls: 1, maxSteps: 1 } };
  return { ...base, kind };
}

function intent(continuation: CentralLearningIntentDraft["continuation"], revisionReason = "The original source establishes this open purpose"): CentralLearningIntentDraft {
  return { intentId: "intent:original", subject: { plane: "agent", domain: "prompt", issueId }, goal: "Identify when the method is useful",
    rationale: "The original condition was different", conditions: ["The original method is available"], knowledge: [], residual: ["The condition remains unresolved"],
    commitment: { purpose: "Resolve the original uncertainty", assumptions: ["The source is still applicable"], reconsiderWhen: ["A contrary receipt arrives"] },
    revisionReason, sourceRefs: [sourceRef], continuation };
}

function output(intents: readonly CentralLearningIntentDraft[]): CentralDeliberationOutput {
  return { schemaVersion: 1, intents, publicExplanation: "Keep the original purpose and choose the supported next operation.", sourceRefs: [sourceRef] };
}

const waitingIntent = () => intent({ kind: "waiting", wait: { kind: "facts", reason: "A discriminating fact is still missing", sourceRefs: [sourceRef] } });

async function directory(t: TestContext) {
  const base = testScratchPath("central-runtime-driver-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

type Semantic = (request: CentralDeliberationRequest, index: number) => CentralDeliberationOutput | Promise<CentralDeliberationOutput>;

async function harness(t: TestContext, semantic: Semantic, override: Partial<CentralRuntimeExecutionPort> = {}, control: {
  readonly now?: () => string; readonly inspect?: CentralDeliberationPort["inspect"]; readonly recoveryDelayMs?: number;
  readonly prepareDelivery?: CentralDeliberationPort["prepareDelivery"];
  readonly selectAutomaticOutput?: CentralDeliberationPort["selectAutomaticOutput"];
  readonly organization?: CentralRuntimeOrganizationPort;
  readonly snapshot?: (snapshot: CentralRuntimeSnapshot) => CentralRuntimeSnapshot;
} = {}) {
  const boardRoot = await directory(t), abort = new AbortController();
  t.after(() => abort.abort());
  const report = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "report:initial", issuedAt: now(), action: {
    kind: "report", scope, issueId, problemKey: "method:condition", report: { reportId: sourceRef,
      source: { subsystem: "method", taskId: "task:original", versionId: "method:original" }, facts: [sourceMaterial.text], evidenceRefs: [sourceRef] } } }));

  assert.ok(report.ok, JSON.stringify(report));
  const requests: CentralDeliberationRequest[] = [], sourceReads: string[][] = [], published: CentralLearningDriverProgress[] = [];
  const source: CentralRuntimeSourcePort = {
    async snapshot() {
      const loaded = await createBoardReader(boardRoot).load();
      assert.ok(loaded.ok);
      const original = loaded.state.learningIssues?.find(row => row.issueId === issueId);
      assert.ok(original);
      const result: CentralRuntimeSnapshot = { boardSequence: loaded.state.sequence, opportunities: [{ subject: { plane: "agent", domain: "prompt", issueId },
        sourceRef: original.reports[0]!.reportId, description: original.reports[0]!.facts.join("\n"), constraints: [] }], materials: [sourceMaterial], sourceRefs: [sourceRef] };
      return control.snapshot?.(result) ?? result;
    },

    async read(_scope, refs) {
      sourceReads.push([...refs]);
      return [{ ref: "material:read-result", kind: "source", text: "The original evidence identifies the missing condition.", sourceRefs: [sourceRef] }];
    },
  };
  const execution: CentralRuntimeExecutionPort = {
    async consult() { return { ref: "advice:one", kind: "numerical_advice", text: "A bounded next comparison is feasible.", sourceRefs: [sourceRef] }; },
    async prepare(input) { return { intentId: input.intent.intentId, operation: input.operation, workRef: "work:one", frame: { originalStageRef: "stage:one" } }; },
    async execute() { return { outcome: "returned", resultRefs: ["result:one"], publicResult: "The original worker returned a condition-specific proposal." }; },
    async recover() { return null; },
    ...override,
  };
  const driver = createCentralLearningDriver({ boardRoot, scope, enabled: () => !abort.signal.aborted, now: control.now ?? now, source,
    deliberation: { async deliberate(request) {
      requests.push(request);
      return semantic(request, requests.length);
    },

      ...(control.prepareDelivery === undefined ? {} : { prepareDelivery: control.prepareDelivery }),
      ...(control.selectAutomaticOutput === undefined ? {} : { selectAutomaticOutput: control.selectAutomaticOutput }),
      ...(control.inspect === undefined ? {} : { inspect: control.inspect }) }, execution,
    ...(control.organization === undefined ? {} : { organization: control.organization }),
    ...(control.recoveryDelayMs === undefined ? {} : { semanticRecoveryDelayMs: control.recoveryDelayMs }) });
  const input: CentralLearningDriveInput = { scope, configuration, wake: { reason: "original_source_available", sourceRefs: [sourceRef] }, signal: abort.signal,
    publish(value) { published.push(value); } };

  return { boardRoot, requests, sourceReads, published, driver, input, source, execution,
    state: () => createCentralRuntimeStore({ boardRoot, enabled: () => true }).read(scope) };
}

test("automatic output investment is canonical before issue and never rewrites the model's next thought", async t => {
  let selections = 0;
  const next = { ...operation("think:model-selected", "think"), kind: "think" as const, maxOutputTokens: 6000 };
  const modelDefault = operation("think:model-owned-default", "think");
  const h = await harness(t, (_request, index) => output([index === 1 ? intent({ kind: "ready", operation: next })
    : index === 2 ? intent({ kind: "ready", operation: modelDefault }) : waitingIntent()]), {}, {
    async selectAutomaticOutput(request, _signal, constraints) {
      selections++;
      assert.match(request.operation.operationId, /^central-agenda:/);
      assert.equal(request.operation.kind, "think");
      assert.ok(constraints?.sourceProgressFits(request));
      return 2100;
    }, async prepareDelivery(request) {
      const issued = request.state.completed.find(row => row.operation.operationId === request.operation.operationId);
      assert.ok(issued);
      assert.deepEqual(issued.operation, request.operation);
      assert.equal(issued.outcome, "unknown");
      return request;
    } });
  const input = { ...h.input, configuration: { ...h.input.configuration,
    generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 } } };

  await h.driver.drive(input);
  await h.driver.drive(input);
  await h.driver.drive(input);
  assert.equal(selections, 1);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[0]!.operation.kind === "think" && h.requests[0]!.operation.maxOutputTokens, 2100);
  assert.deepEqual(h.requests[1]!.operation, next);
  assert.deepEqual(h.requests[2]!.operation, modelDefault, "a model-owned operation without an explicit size still keeps its original generation policy");
  const stored = await h.state(), automatic = stored.state.completed.find(row => row.operation.operationId === h.requests[0]!.operation.operationId);

  assert.ok(automatic);
  assert.deepEqual(automatic.operation, h.requests[0]!.operation);
  assert.equal(automatic.outcome, "returned");
  await h.driver.close?.();
});

async function refusal(action: Promise<CentralLearningDriverProgress>, reason: RegExp) {
  let result: CentralLearningDriverProgress;
  try { result = await action; }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, reason);
    return;
  }
  assert.equal(result.state, "waiting");
  assert.match(result.reason, reason);
}

test("a committed native dispatch progresses before an unrelated meta review while its original agenda read stays queued", async t => {
  let freshMeta = false, preparations = 0;
  const read = { kind: "read" as const, operationId: "agenda-read:queued-before-work", purpose: "Inspect the original after the committed work starts",
    expectedChange: "Read the same original once", sourceRefs: [sourceRef], refs: [sourceRef], maximumChars: 2048 };
  const h = await harness(t, () => ({ ...output([intent({ kind: "ready", operation: operation("dispatch:committed-native", "dispatch") })]), agendaRead: read }), {
    async prepare(input) {
      preparations++;
      return { intentId: input.intent.intentId, operation: input.operation, workRef: "work:committed-native", frame: { originalStageRef: "stage:committed-native" } };
    },
  }, { snapshot(original) {
    return !freshMeta ? original : { ...original,
      materials: [...original.materials, { ref: "notice:later-meta", kind: "source", text: "A later organization result is available.", sourceRefs: [] }],
      sourceRefs: [...original.sourceRefs, "notice:later-meta"],
      reconsider: [{ subject: { plane: "agent", domain: "tool", issueId: "issue:unrelated-meta" }, sourceRefs: ["notice:later-meta"], reason: "original_organization_feedback_changed" }] };
  } });
  await h.driver.drive(h.input);
  freshMeta = true;
  const dispatched = await h.driver.drive(h.input);
  assert.deepEqual(dispatched.sourceRefs, ["work:committed-native"]);
  assert.equal(preparations, 1);
  assert.equal(h.requests.length, 1, "a meta source cannot buy another thought instead of starting committed work");
  assert.deepEqual(h.sourceReads, []);
  assert.deepEqual((await h.state()).state.agendaRead, read, "scheduling work does not cancel or acknowledge the queued original read");
  await h.driver.drive(h.input);
  assert.deepEqual(h.sourceReads, [[sourceRef]], "the same queued source read continues after native work starts");
  await h.driver.close?.();
});

test("a cold legacy stale admission resumes the original identity only after original funding proof", async t => {
  const h = await harness(t, () => { throw Object.assign(new Error("learning_budget_stale"), { failureClass: "resources" }); });

  await h.driver.drive(h.input);
  await h.driver.close?.();
  const failed = await h.state(), original = failed.state.completed.at(-1)!;

  assert.equal(original.outcome, "failed");
  const board = await createBoardReader(h.boardRoot).load();
  assert.ok(board.ok);
  const root = board.state.centralLearningBudgets![0]!;
  const funding = createCentralAccountingFundingAtRoot({ boardRoot: h.boardRoot, scope, budgetId: root.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:original-owner" }, now, enabled: () => true });
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://admission.invalid/v1/chat/completions", model: "local",
    apiKey: "local", fetchImpl: async () => { throw new Error("No external request belongs in this recovery test"); } });
  const model = createCentralModelDeliberation({ provider, model: "local", funding });
  let admitted = 0;

  for (const kind of ["bare_not_sent", "wrong_root"] as const) {
    const rejected = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source: h.source,
      execution: h.execution, deliberation: { async deliberate() { throw new Error("Unproved admission must not execute"); },

        async inspect(input, signal) {
          if (kind === "bare_not_sent") return { status: "not_sent", sourceRefs: [] };
          const found = await model.inspect!(input, signal);
          assert.equal(found.status, "not_sent");
          if (found.status !== "not_sent" || found.admission === undefined) throw new Error("Expected original funding proof");
          return { ...found, admission: { ...found.admission, rootRef: { ...found.admission.rootRef, openedSequence: root.openedSequence + 1 } } };
        } } });

    assert.equal((await rejected.drive(h.input)).state, "waiting");
    assert.equal((await h.state()).stateRef, failed.stateRef);
    await rejected.close?.();
  }

  const restarted = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now,
    source: h.source, execution: h.execution, deliberation: { inspect: model.inspect!, async deliberate(request) {
      admitted += 1;
      assert.deepEqual(request.operation, original.operation);
      assert.equal(request.state.completed.filter(row => row.operation.operationId === original.operation.operationId).length, 1);
      assert.ok(!request.operation.operationId.startsWith("central-recover-thought:"));
      return output([waitingIntent()]);
    } } });

  assert.equal((await restarted.drive(h.input)).state, "waiting");
  const recovered = await h.state();
  assert.equal(admitted, 1);
  assert.equal(recovered.state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "returned");
  assert.equal(recovered.state.materials.some(row => row.ref.startsWith("central-semantic-recovery-blocked:")), false);
  await restarted.drive(h.input);
  assert.equal(admitted, 1);
  assert.ok(recovered.history.materials.some(row => failed.state.materials.some(old => old.ref === row.ref
    && old.ref.startsWith("central-semantic-recovery-blocked:"))), "the original refusal remains in verified history");
  await restarted.close?.();
});

test("a source review receipt after stale admission retires the original wait on cold recovery", async t => {
  let changed = false;
  const h = await harness(t, () => { throw Object.assign(new Error("learning_budget_stale"), { failureClass: "resources" }); }, {}, {
    snapshot: snapshot => changed ? changedSnapshot(snapshot, "feedback:admission-current-condition", true) : snapshot,
  });

  await h.driver.drive(h.input);
  await h.driver.close?.();
  const failed = await h.state(), original = failed.state.completed.at(-1)!;

  await sourceFact(h.boardRoot, "feedback:admission-current-condition");
  changed = true;
  const board = await createBoardReader(h.boardRoot).load();
  assert.ok(board.ok);
  const root = board.state.centralLearningBudgets![0]!;
  const funding = createCentralAccountingFundingAtRoot({ boardRoot: h.boardRoot, scope, budgetId: root.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:original-owner" }, now, enabled: () => true });
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: h.boardRoot, scope, budgetId: root.budgetId, enabled: () => true });
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://admission.invalid/v1/chat/completions", model: "local", apiKey: "local",
    fetchImpl: async () => { throw new Error("No external request belongs in this recovery test"); } });
  const model = createCentralModelDeliberation({ provider, model: "local", funding, receipts });
  let calls = 0;
  const interrupted = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source: h.source,
    execution: h.execution, deliberation: { inspect: model.inspect!,
      async prepareDelivery(request) { return packCentralDeliberationContext(request, () => true); }, async deliberate(request, signal) {
      calls += 1;
      assert.notEqual(request.operation.operationId, original.operation.operationId);
      assert.equal(request.state.materials.length, 0, "the actual delivery projection does not carry host bookkeeping in state");
      assert.match(request.operation.operationId, /^central-(agenda|reconsider):/);
      assert.ok(request.operation.sourceRefs.includes("feedback:admission-current-condition"));
      await receipts.save({ request, output: output([waitingIntent()]) }, signal);
      throw new Error("Process interrupted after the original immutable receipt");
    } } });

  await interrupted.drive(h.input);
  await interrupted.close?.();
  const cold = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source: h.source,
    execution: h.execution, deliberation: { inspect: model.inspect!, async deliberate() { throw new Error("The original receipt must recover without another call"); } } });

  await cold.drive(h.input);
  const recovered = await h.state();
  assert.equal(calls, 1);
  assert.equal(recovered.state.materials.some(row => row.ref.startsWith("central-semantic-recovery-blocked:")), false);
  assert.ok(recovered.state.intents.some(row => row.intentId === "intent:original"));
  await cold.drive(h.input);
  await cold.close?.();
});

test("a successful receipt considers its actual opportunity once without reading its other notice representation", async t => {
  for (const finalDelivery of ["offered", "trimmed"] as const) {
    const h = await harness(t, () => output([intent({ kind: "ready", operation: operation("op:interpret-original-return", "think") })]));

    await h.driver.drive(h.input);
    await h.driver.close?.();
    const pair = centralIssueSourceRefs(contentHashOf(["one-original-skill-opportunity", finalDelivery]));
    const extra = { subject: { plane: "agent" as const, domain: "skill" as const, issueId: "issue:original-skill-opportunity" },
      sourceRef: pair.body, description: "The visible task completed its execution boundary; quality remains unknown.", constraints: ["unreviewed"] };
    const catalogText = canonicalJson({ role: "original_report_catalog_not_read_body", availableIssues: 1, shownIssues: 1, nextReadRef: null,
      entries: [{ issueId: extra.subject.issueId, noticeRef: pair.notice, owner: "skill", problem: extra.description,
        readRef: pair.body, reportCount: 1, role: "original_report" }] });
    const catalog = { ref: `central-runtime-catalog:${contentHashOf(catalogText)}`, kind: "source" as const,
      text: catalogText, sourceRefs: [pair.notice] };
    const source: CentralRuntimeSourcePort = { ...h.source, async snapshot(...args) {
      const snapshot = await h.source.snapshot(...args);
      return { ...snapshot, opportunities: [...snapshot.opportunities, extra], materials: [...snapshot.materials, catalog],
        sourceRefs: [...snapshot.sourceRefs, pair.notice] };
    } };
    const board = await createBoardReader(h.boardRoot).load();
    assert.ok(board.ok);
    const root = board.state.centralLearningBudgets![0]!;
    const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: h.boardRoot, scope, budgetId: root.budgetId, enabled: () => true });
    let calls = 0;
    const port: CentralDeliberationPort = {
      async prepareDelivery(request) { return packCentralDeliberationContext(request, () => true); },

      async deliberate(request, signal) {
        calls += 1;
        assert.equal(request.operation.operationId, "op:interpret-original-return");
        assert.ok(request.opportunities.some(row => row.sourceRef === pair.body));
        const actual = finalDelivery === "offered" ? request : { ...request,
          opportunities: request.opportunities.filter(row => row.sourceRef !== pair.body) };
        const result = output([waitingIntent()]);
        await receipts.save({ request: actual, output: result }, signal);
        return result;
      },

      async inspect(input, signal) { const found = await receipts.read(input.operationId, signal);
        return found === undefined ? { status: "not_sent", sourceRefs: [] } : { status: "returned", ...found }; },
    };
    const driver = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source, execution: h.execution, deliberation: port });
    const result = await driver.drive(h.input);
    assert.equal(result.state, "waiting");
    await driver.close?.();
    const saved = await h.state();

    assert.equal(saved.history.consideredSourceRefs?.includes(pair.body), finalDelivery === "offered");
    assert.equal(saved.history.consumedSourceRefs.includes(pair.notice), false, "opportunity consideration never acknowledges its undispatched notice");
    assert.equal(h.sourceReads.length, 0, "no original report body was read to mark consideration");

    if (finalDelivery === "offered") {
      const cold = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source, execution: h.execution, deliberation: port });
      for (let wake = 0; wake < 3; wake += 1) assert.equal((await cold.drive({ ...h.input,
        wake: { reason: "duplicate_hint", sourceRefs: [] } })).state, "waiting");
      assert.equal(calls, 1);
      await cold.close?.();
    }
  }
});

async function sourceFact(boardRoot: string, id: string) {
  const port = createRewardV2BoardPort(boardRoot, () => true), before = await port.read();
  const written = await port.append(before.revision, { id, scope, algorithmVersion: "original-feedback-owner-v1", kind: "feedback",
    payloadJson: JSON.stringify({ type: "original_condition_change", sourceRef: id }) });
  assert.equal(written.status, "written");
}

function changedSnapshot(snapshot: CentralRuntimeSnapshot, ref: string, relevant: boolean): CentralRuntimeSnapshot {
  return { ...snapshot, sourceRefs: [...snapshot.sourceRefs, ref], materials: [...snapshot.materials,
    { ref, kind: "feedback", text: "The source owner clarified the condition or withdrew the old purpose.", sourceRefs: [sourceRef] }],
    reconsider: [{ subject: relevant ? { plane: "agent", domain: "prompt", issueId } : { plane: "agent", domain: "tool", issueId: "issue:unrelated" },
      reason: "New original feedback changes the pending research commitment", sourceRefs: [ref] }] };
}

test("a canonical unreviewed source automatically invokes the learning controller without PA focus", async t => {
  const h = await harness(t, () => output([waitingIntent()]));
  const result = await h.driver.drive(h.input);

  assert.equal(result.state, "waiting");
  assert.equal(h.requests.length, 1);
  const board = await createBoardReader(h.boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.learningIssues?.[0]?.decision.kind, "unreviewed", "the controller does not require or fake a PA focus decision");
  const saved = await h.state();
  assert.equal(saved.state.intents[0]?.goal, "Identify when the method is useful");
  assert.equal(saved.state.intents[0]?.continuation.kind, "waiting");
  assert.ok(saved.state.consumedSourceRefs.includes(sourceRef));
  assert.equal(h.requests[0]?.opportunities[0]?.sourceRef, sourceRef);
});

test("a stable source can support complementary think, read or consult, then fresh interpretation", async t => {
  for (const kind of ["read", "consult"] as const) {
    let consultations = 0;
    const backlog = `notice:known-unread-${kind}`;
    const choose: Semantic = (_request, index) => index === 1
      ? output([intent({ kind: "ready", operation: operation(`op:${kind}`, kind) })]) : output([waitingIntent()]);
    const h = await harness(t, choose, {
      async consult() {
        consultations += 1;
        return { ref: "advice:one", kind: "numerical_advice", text: "The feasible budget favors one useful comparison.", sourceRefs: [sourceRef] };
      },
    }, { prepareDelivery: async request => request, snapshot: snapshot => ({ ...snapshot,
      sourceRefs: [...snapshot.sourceRefs, backlog], reconsider: [{ subject: { plane: "agent", domain: "prompt", issueId },
        sourceRefs: [backlog], reason: "The same original unread address remains available" }] }) });

    assert.equal((await h.driver.drive(h.input)).state, "ready");
    const frozen = await h.state();
    assert.ok(!frozen.history.consumedSourceRefs.includes(backlog));
    assert.ok(frozen.history.choiceFrontiers?.find(row => row.intentId === "intent:original")?.sourceRefs.includes(backlog));
    await h.driver.close?.();
    const resumed = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source: h.source, execution: h.execution,
      deliberation: { prepareDelivery: async request => request, async deliberate(request) {
        h.requests.push(request);
        return choose(request, h.requests.length);
      } } });

    t.after(() => resumed.close?.());
    assert.equal((await resumed.drive(h.input)).state, "ready");
    assert.equal(h.requests.length, 1, "the local read/consult is a distinct operation, not an extra semantic request");
    assert.equal((await resumed.drive(h.input)).state, "waiting");
    assert.equal(h.requests.length, 2);
    assert.equal(consultations, kind === "consult" ? 1 : 0);
    assert.equal(h.sourceReads.length, kind === "read" ? 1 : 0);
    const second = h.requests[1]!;

    assert.equal(second.operation.kind, "think");
    assert.ok(second.materials.some(row => row.ref === (kind === "read" ? "material:read-result" : "advice:one")));
    assert.equal(second.state.intents[0]?.goal, h.requests[0]?.state.intents[0]?.goal ?? "Identify when the method is useful");
    assert.equal((await h.state()).state.completed.filter(row => row.operation.operationId === `op:${kind}`).length, 1);
    assert.ok(!(await h.state()).history.consumedSourceRefs.includes(backlog), "a fair handoff never marks the unread address delivered");
    assert.equal((await resumed.drive(h.input)).state, "waiting");
    assert.equal(h.requests.length, 2, "the unchanged address does not buy another interpretation after waiting");
  }
});

test("a gated domain worker returns waiting immediately and publishes ready only after its actual result", async t => {
  const started = deferred<void>(), release = deferred<CentralRuntimeWorkResult>(), ready = deferred<void>();
  let executions = 0;
  const h = await harness(t, (_request, index) => index === 1
    ? output([intent({ kind: "ready", operation: operation("op:dispatch", "dispatch") })]) : output([waitingIntent()]), {
    execute() {
      executions += 1;
      started.resolve();
      return release.promise;
    },
  });
  const input = { ...h.input, publish(value: CentralLearningDriverProgress) {
    h.published.push(value);
    ready.resolve();
  } };

  await h.driver.drive(input);
  const running = h.driver.drive(input);

  await started.promise;
  const first = await Promise.race([running.then(value => ({ kind: "returned" as const, value })), nextTurn().then(() => ({ kind: "still_blocked" as const }))]);

  try {
    assert.equal(first.kind, "returned", "background work must not retain the business-facing drive promise");
    if (first.kind === "returned") assert.equal(first.value.state, "waiting");
    assert.equal(h.requests.length, 1);
    assert.equal(h.published.length, 0);
    const before = await h.state();
    assert.equal(before.state.running.length, 1);
    assert.equal(before.state.completed.some(row => row.operation.operationId === "op:dispatch"), false);
    assert.equal((await h.driver.drive(input)).state, "waiting");
    assert.equal(executions, 1);
  } finally {
    release.resolve({ outcome: "returned", resultRefs: ["work:one", "result:worker"], publicResult: "A real original worker receipt returned." });
  }

  await ready.promise;
  assert.equal(h.published[0]?.state, "ready");
  const after = await h.state();
  assert.equal(after.state.running.length, 0);
  assert.equal(after.state.completed.find(row => row.operation.operationId === "op:dispatch")?.outcome, "returned");
  assert.equal((await h.driver.drive(input)).state, "waiting");
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1]?.materials.some(row => row.text.includes("A real original worker receipt returned.")));
  await h.driver.close?.();
  const terminal = new Error("original_worker_feedback_write_unconfirmed"), surfaced = deferred<CentralLearningDriverProgress>();
  let faultExecutions = 0;
  const fault = await harness(t, () => output([intent({ kind: "ready", operation: operation("op:fault-publication", "dispatch") })]), {
    async execute() {
      faultExecutions += 1;
      return { outcome: "returned", resultRefs: ["work:one"], publicResult: "The original worker completed." };
    },
  }, { organization: { async recall() { return []; }, async recordResult() { throw terminal; } } });
  const faultInput = { ...fault.input, publish(value: CentralLearningDriverProgress) {
    surfaced.resolve(value);
    throw new Error("diagnostic_progress_callback_failed");
  } };

  await fault.driver.drive(faultInput);
  await fault.driver.drive(faultInput);
  const notification = await surfaced.promise;

  assert.equal(notification.state, "ready");
  assert.equal(notification.reason, "central_work_return_unconfirmed");
  const failedHead = await fault.state();

  await assert.rejects(fault.driver.drive(faultInput), error => error === terminal, "the next drive surfaces the original terminal error");
  assert.equal(fault.requests.length, 1);
  assert.equal(faultExecutions, 1);
  assert.equal((await fault.state()).stateRef, failedHead.stateRef, "surfacing the error performs no new work or write");
  await fault.driver.close?.();
});

test("repeated wakes and unrelated Board writes do not invoke another semantic computation", async t => {
  const h = await harness(t, () => output([waitingIntent()]));

  await h.driver.drive(h.input);
  const first = await h.state();
  const port = createRewardV2BoardPort(h.boardRoot, () => true), snapshot = await port.read();

  await port.append(snapshot.revision, { id: "unrelated:fact", scope, algorithmVersion: "unrelated-owner-v1", kind: "projection", payloadJson: "{}" });
  await h.driver.drive({ ...h.input, wake: { reason: "unrelated_board_change", sourceRefs: ["unrelated:fact"] } });
  await h.driver.drive(h.input);
  assert.equal(h.requests.length, 1);
  const last = await h.state();
  assert.equal(last.stateRef, first.stateRef, "an unchanged semantic source does not manufacture a runtime transition");
  assert.equal(last.revision, first.revision + 1, "the unrelated original Board fact is retained");
});

test("a complete agenda cannot silently omit an existing intent", async t => {
  const h = await harness(t, (_request, index) => index === 1
    ? output([intent({ kind: "ready", operation: operation("op:follow-up", "think") })]) : output([]));

  await h.driver.drive(h.input);
  await refusal(h.driver.drive(h.input), /central_intent_removed_without_history/);
  assert.equal(h.requests.length, 2);
  const saved = await h.state();
  assert.equal(saved.state.intents.length, 1);
  assert.equal(saved.state.intents[0]?.intentId, "intent:original");
  assert.equal(saved.state.intents[0]?.goal, "Identify when the method is useful");
});

test("a completed exact operation cannot be repurchased merely by changing its ID", async t => {
  const first = operation("op:read-first", "read");
  const h = await harness(t, (_request, index) => index === 1
    ? output([intent({ kind: "ready", operation: first })])
    : output([intent({ kind: "ready", operation: { ...first, operationId: "op:read-renamed" } }, "The ID was renamed without changing any meaning or source")]));

  await h.driver.drive(h.input);
  await h.driver.drive(h.input);
  await refusal(h.driver.drive(h.input), /central_operation_(already_issued|semantically_repeated|equivalent|duplicate)/);
  assert.equal(h.sourceReads.length, 1);
  const saved = await h.state();

  assert.equal(saved.state.intents.some(row => row.continuation.kind === "ready" && row.continuation.operation.operationId === "op:read-renamed"), false);
});

test("an explicit until wait exposes its real wake time and resumes the committed purpose when due", async t => {
  let clock = Date.parse(now());
  const due = clock + 1000;
  const h = await harness(t, (_request, index) => index === 1 ? output([intent({ kind: "waiting", wait: {
    kind: "until", at: due, sourceRefs: [sourceRef], reason: "The original experiment is meaningful after this time" } })])
    : output([waitingIntent()]), {}, { now: () => new Date(clock).toISOString() });
  const initial = await h.driver.drive(h.input);
  assert.equal(initial.state, "waiting");
  assert.equal(initial.wakeAt, due);
  clock = due - 1;
  const early = await h.driver.drive(h.input);
  assert.equal(early.wakeAt, due);
  assert.equal(h.requests.length, 1);
  clock = due;
  assert.equal((await h.driver.drive(h.input)).state, "waiting");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]?.state.intents[0]?.goal, "Identify when the method is useful");
});

test("close waits for a retiring worker and fences its late result from further writes and publication", async t => {
  const started = deferred<void>(), release = deferred<CentralRuntimeWorkResult>();
  const h = await harness(t, () => output([intent({ kind: "ready", operation: operation("op:retiring", "dispatch") })]), {
    execute() {
      started.resolve();
      return release.promise;
    },
  });

  await h.driver.drive(h.input);
  await h.driver.drive(h.input);
  await started.promise;
  const before = await h.state();
  assert.equal(before.state.running.length, 1);
  assert.ok(h.driver.close, "the scope owner needs a retirement boundary");
  let retired = false;
  const closing = h.driver.close().then(() => { retired = true; });

  try {
    await nextTurn();
    assert.equal(retired, false, "close must wait for the actual worker promise to retire");
  }
  finally { release.resolve({ outcome: "returned", resultRefs: ["late:receipt"], publicResult: "The retired worker returned late." }); }

  await closing;
  assert.equal(retired, true);
  const after = await h.state();
  assert.equal(after.stateRef, before.stateRef);
  assert.deepEqual(after.state, before.state);
  assert.equal(h.published.length, 0);
  assert.equal((await h.driver.drive(h.input)).state, "waiting");
  assert.equal(h.requests.length, 1);
  assert.equal((await h.state()).stateRef, before.stateRef);
});

test("restart recovers the original returned semantic response through inspect without sending it again", async t => {
  const h = await harness(t, () => { throw new Error("provider_response_unknown"); });

  assert.equal((await h.driver.drive(h.input)).state, "waiting");
  assert.equal(h.requests.length, 1);
  const original = h.requests[0]!;
  await h.driver.close?.();
  const staleChoice = "operation:old-unapplied-choice";
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: h.boardRoot, scope, budgetId: original.budgetId, enabled: () => true });
  const delivery = await receipts.save({ request: original, output: output([intent({ kind: "ready", operation: operation(staleChoice, "think") })]) });

  await sourceFact(h.boardRoot, "feedback:newer-public-condition");
  const newer = { ...waitingIntent(), residual: ["The newer public condition remains unresolved."],
    sourceRefs: [sourceRef, "feedback:newer-public-condition"] };
  const store = createCentralRuntimeStore({ boardRoot: h.boardRoot, enabled: () => true }), pending = await h.state();

  assert.equal((await store.append({ expectedRevision: pending.revision, previousRef: pending.stateRef,
    state: { ...pending.state, intents: [newer] }, reason: "newer_original_public_condition", sourceRefs: newer.sourceRefs })).status, "written");
  const service = createCentralOrganizationService({ boardRoot: h.boardRoot, scope, enabled: () => true });
  const organization = createCentralRuntimeOrganization({ boardRoot: h.boardRoot, scope, enabled: () => true, service });
  let resent = 0, inspected = 0;
  let loseFreezeAck = true;
  const restarted = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source: h.source,
    organization: { ...organization, async recordDecision(input, signal) {
      assert.equal(input.role, "deliberation");
      assert.equal(input.effects, "record_only");
      assert.equal(input.deliveryRef, delivery.deliveryRef);
      assert.equal((await h.state()).state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "unknown",
        "the original pending computation must survive until its decision is frozen");
      await organization.recordDecision!(input, signal);
      if (loseFreezeAck) {
        loseFreezeAck = false;
        throw new Error("organization_freeze_ack_lost_after_original_write");
      }
    } },
    execution: h.execution, deliberation: {
      async deliberate() {
        resent += 1;
        throw new Error("blind_replay_forbidden");
      },

      async inspect(input) {
        inspected += 1;
        assert.equal(input.operationId, original.operation.operationId);
        return { status: "returned", ...delivery };
      },
    } });

  await assert.rejects(restarted.drive(h.input), /organization_freeze_ack_lost_after_original_write/);
  const frozen = await service.read();
  assert.equal(frozen.status, "ready");
  if (frozen.status !== "ready") return;

  assert.equal(frozen.projection.decisions.length, 1);
  assert.notEqual(frozen.projection.decisions[0]!.value.decisionRef, original.operation.operationId);
  assert.equal(frozen.projection.decisions[0]!.value.purposeRef, original.operation.operationId);
  assert.ok(frozen.projection.decisions[0]!.value.sourceRefs.includes(delivery.deliveryRef));
  assert.deepEqual((await h.state()).state.intents, [newer]);
  assert.equal((await restarted.drive(h.input)).state, "waiting");
  assert.equal(resent, 0);
  assert.equal(inspected, 2);
  const recovered = await h.state();
  assert.deepEqual(recovered.state.intents, [newer], "late public evidence cannot replace the newer agenda");
  assert.equal(recovered.state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "returned");
  const after = await service.read();
  assert.equal(after.status, "ready");
  if (after.status !== "ready") return;

  assert.deepEqual(after.projection.decisions.map(row => row.factId), frozen.projection.decisions.map(row => row.factId), "retry reuses the original computation fact");
  assert.equal(after.projection.decisions.some(row => row.value.decisionRef === staleChoice), false);
  await restarted.drive(h.input);
  assert.equal(inspected, 2);
  assert.equal(resent, 0);
  await restarted.close?.();
});

test("unknown semantic responses permit only one distinct bounded recovery after backoff and then wait", async t => {
  let clock = Date.parse(now());
  const h = await harness(t, () => { throw new Error("provider_response_unknown"); }, {}, {
    now: () => new Date(clock).toISOString(), recoveryDelayMs: 50,
  });
  const first = await h.driver.drive(h.input);
  assert.equal(first.state, "waiting");
  assert.equal(first.wakeAt, clock + 50);
  clock += 49;
  await h.driver.drive(h.input);
  assert.equal(h.requests.length, 1);
  clock += 1;
  const recovered = await h.driver.drive(h.input);
  assert.equal(recovered.state, "waiting");
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1]?.operation.operationId, h.requests[0]?.operation.operationId, "recovery is a new operation, never retransmission of the old reservation");
  assert.ok(h.requests[1]?.operation.sourceRefs.includes(h.requests[0]!.operation.operationId));
  assert.equal(recovered.wakeAt, undefined, "two consecutive unknown responses do not create an automatic retry clock");
  clock += 100000;
  await h.driver.drive(h.input);
  await h.driver.drive(h.input);
  assert.equal(h.requests.length, 2);
  const saved = await h.state();
  assert.equal(saved.state.completed.filter(row => row.outcome === "unknown").length, 2);
  await h.driver.close?.();
});

test("late domain results retain evidence without reviving an ended or redirected intent", async t => {
  for (const direction of ["ended", "redirected"] as const) {
    let changed = false;
    const started = deferred<void>(), release = deferred<CentralRuntimeWorkResult>(), completed = deferred<void>();
    const next = direction === "ended" ? intent({ kind: "ended", goalState: "withdrawn", reason: "The original purpose was withdrawn" }, "Original feedback withdrew this investment")
      : { ...intent({ kind: "ready", operation: operation("op:new-direction", "read") }, "Original feedback changes the research direction"), goal: "Investigate the clarified condition" };
    const h = await harness(t, (_request, index) => index === 1
      ? output([intent({ kind: "ready", operation: operation("op:old-worker", "dispatch") })]) : output([next]), {
      execute() {
        started.resolve();
        return release.promise;
      },
    }, { snapshot: snapshot => changed ? changedSnapshot(snapshot, "feedback:revised-purpose", true) : snapshot });
    const input = { ...h.input, publish(value: CentralLearningDriverProgress) {
      h.published.push(value);
      completed.resolve();
    } };

    await h.driver.drive(input);
    await h.driver.drive(input);
    await started.promise;
    await sourceFact(h.boardRoot, "feedback:revised-purpose");
    changed = true;
    const reconsidered = await h.driver.drive(input);

    assert.equal(reconsidered.state, direction === "ended" ? "waiting" : "ready");
    assert.equal(h.requests.length, 2);
    const before = await h.state();
    assert.deepEqual(before.state.intents, [next]);
    release.resolve({ outcome: "returned", resultRefs: ["result:old-worker-late"], publicResult: "The previous direction's proposal returned after revision." });
    await completed.promise;
    const after = await h.state();

    if (direction === "ended") {
      assert.ok(after.state.intents.every(row => row.continuation.kind === "ended"), "late work cannot revive a withdrawn purpose");
      const archived = await createCentralRuntimeStore({ boardRoot: h.boardRoot, enabled: () => true }).lookup(scope, { kind: "ended_intent", intentId: next.intentId });
      assert.equal(archived.status, "found");
      if (archived.status === "found") assert.deepEqual(archived.value, next);
    } else assert.deepEqual(after.state.intents, [next], "late work records evidence without replacing the current commitment");

    assert.equal(after.state.running.length, 0);
    assert.equal(after.state.completed.find(row => row.operation.operationId === "op:old-worker")?.outcome, "returned");
    assert.ok(after.state.materials.some(row => row.text.includes("previous direction's proposal")));
    await h.driver.close?.();
  }
});

test("dispatching one background worker leaves a second ready intent runnable immediately", async t => {
  const release = deferred<CentralRuntimeWorkResult>();
  const first = intent({ kind: "ready", operation: operation("op:first-worker", "dispatch") });
  const second = { ...intent({ kind: "ready", operation: operation("op:second-read", "read") }), intentId: "intent:second", goal: "Read the complementary evidence" };
  const h = await harness(t, () => output([first, second]), { execute: () => release.promise });

  await h.driver.drive(h.input);

  try {
    assert.equal((await h.driver.drive(h.input)).state, "ready", "one active domain does not hide another runnable commitment");
    assert.equal(h.requests.length, 1);
    const state = await h.state();
    assert.equal(state.state.running.length, 1);
    assert.equal(state.state.intents.find(row => row.intentId === second.intentId)?.continuation.kind, "ready");
    assert.equal((await h.driver.drive(h.input)).state, "ready");
    assert.equal(h.sourceReads.length, 1);
  } finally {
    const closing = h.driver.close?.();
    release.resolve({ outcome: "returned", resultRefs: ["result:first"], publicResult: "Original work returned." });
    await closing;
  }
});

test("relevant source reconsideration precedes dispatch while unrelated source changes do not steal ready work", async t => {
  for (const relevant of [true, false]) {
    let changed = false, executed = 0;
    const release = deferred<CentralRuntimeWorkResult>();
    const h = await harness(t, (_request, index) => index === 1
      ? output([intent({ kind: "ready", operation: operation("op:pending-dispatch", "dispatch") })]) : output([waitingIntent()]), {
      execute() {
        executed += 1;
        return release.promise;
      },
    }, { snapshot: snapshot => changed ? changedSnapshot(snapshot, "feedback:pending-change", relevant) : snapshot });

    await h.driver.drive(h.input);
    await sourceFact(h.boardRoot, "feedback:pending-change");
    changed = true;

    try {
      assert.equal((await h.driver.drive(h.input)).state, "waiting");
      assert.equal(executed, relevant ? 0 : 1);
      assert.equal(h.requests.length, relevant ? 2 : 1);
      if (relevant) assert.ok(h.requests[1]?.operation.sourceRefs.includes("feedback:pending-change"));
      else assert.equal((await h.state()).state.running.length, 1);
    } finally {
      const closing = h.driver.close?.();
      release.resolve({ outcome: "returned", resultRefs: ["result:pending"], publicResult: "The selected worker returned." });
      await closing;
    }
  }
});

test("an exact operation older than 256 compacted worksets remains blocked after its live receipt is gone", async t => {
  const original = { ...operation("historic-operation:0", "read"), purpose: "Past original question 0", expectedChange: "Learn original condition 0" };
  const h = await harness(t, request => output([...request.state.intents, intent({ kind: "ready", operation: {
    ...original, operationId: "historic-operation:renamed" } })]));
  const seeded = await withBoardWriter(h.boardRoot, async board => {
    const loaded = await board.load();
    assert.ok(loaded.ok);
    let revision = loaded.state.sequence, previousRef = initialCentralRuntimeRef(scope);

    for (let index = 0; index < 300; index++) {
      const previous = { ...original, operationId: `historic-operation:${index}`, purpose: `Past original question ${index}`, expectedChange: `Learn original condition ${index}` };
      const state = { ...emptyCentralRuntimeState(scope), completed: [{ intentId: `historic-intent:${index}`, operation: previous,
        outcome: "returned" as const, publicResult: `Original result ${index}`, resultRefs: [`historic-result:${index}`] }],
        consumedSourceRefs: [`historic-source:${index}`] };
      const fact = buildCentralRuntimeRecord({ previousRef, state, reason: "Record one new grounded result before compacting older work", sourceRefs: [sourceRef] });
      const result = await board.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: fact.id,
        expectedSequence: revision, fact });
      assert.ok(result.ok, JSON.stringify(result));
      revision = result.state.sequence;
      previousRef = fact.id;
    }

    return { ok: true as const };
  });
  assert.ok(seeded.ok);
  const before = await h.state();
  assert.equal(before.state.completed.length, 1);
  assert.equal(before.history.operations.length, 300);
  assert.equal(before.state.completed.some(row => row.operation.operationId === original.operationId), false);
  await refusal(h.driver.drive(h.input), /central_operation_(already_issued|semantically_repeated|equivalent|duplicate)/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sourceReads.length, 0);
  const after = await h.state();
  assert.equal(after.state.intents.some(row => row.continuation.kind === "ready"
    && row.continuation.operation.operationId === "historic-operation:renamed"), false);
});

test("compacting the consumed-source cursor does not repay for the same original source", async t => {
  const fresh = Array.from({ length: 80 }, (_, index) => `actual-delivered-position:${index}`);
  const h = await harness(t, () => output([waitingIntent()]), {}, { prepareDelivery: async request => request,
    snapshot: snapshot => ({ ...snapshot, materials: [...snapshot.materials, { ref: "material:eighty-actual-positions", kind: "source",
      text: "These original positions were actually delivered together in this successful request.", sourceRefs: fresh }] }) });

  await h.driver.drive(h.input);
  const store = createCentralRuntimeStore({ boardRoot: h.boardRoot, enabled: () => true }), before = await store.read(scope);

  assert.ok(fresh.every(ref => before.state.consumedSourceRefs.includes(ref)), "all eighty first acknowledgements must survive their first checkpoint");
  const result = await store.append({ expectedRevision: before.revision, previousRef: before.stateRef,
    state: { ...before.state, completed: [], materials: [], consumedSourceRefs: [] }, reason: "Compact previously archived working-set receipts and source cursor", sourceRefs: [] });

  assert.equal(result.status, "written");
  if (result.status !== "written") return;

  const compact = await store.read(scope);
  assert.equal(compact.state.consumedSourceRefs.length, 0);
  assert.ok(compact.history.consumedSourceRefs.includes(sourceRef));
  assert.ok(fresh.every(ref => compact.history.consumedSourceRefs.includes(ref)), "cold history retains every confirmed position after working-cursor removal");
  assert.equal((await h.driver.drive(h.input)).state, "waiting");
  assert.equal(h.requests.length, 1);
  assert.equal((await store.read(scope)).stateRef, compact.stateRef);
  const tooMany = await harness(t, () => { throw new Error("a request with unrepresentable fresh acknowledgements cannot be purchased"); }, {}, {
    prepareDelivery: async request => request, snapshot: snapshot => ({ ...snapshot, materials: [...snapshot.materials, { ref: "material:capacity-boundary", kind: "source",
      text: "Original sources exceed the existing acknowledgement field capacity in one delivery.", sourceRefs: Array.from({ length: 256 }, (_, index) => `new-position:${index}`) }] }) });
  const blocked = await tooMany.driver.drive(tooMany.input);
  assert.equal(blocked.state, "waiting");
  assert.equal(blocked.reason, "central_deliberation_source_progress_capacity");
  assert.equal(tooMany.requests.length, 0);
  assert.equal((await tooMany.state()).state.completed.length, 0);
});

test("resource failures create no retry clock and only a real canonical root increase permits reconsideration", async t => {
  let clock = Date.parse(now());
  const h = await harness(t, (_request, index) => {
    if (index === 1) throw new CentralDeliberationError("learning_budget_exhausted");
    return output([waitingIntent()]);
  }, {}, { now: () => new Date(clock).toISOString(), recoveryDelayMs: 50 });
  const first = await h.driver.drive(h.input);
  assert.equal(first.state, "waiting");
  assert.equal(first.wakeAt, undefined);
  clock += 100000;
  await sourceFact(h.boardRoot, "unrelated:resource-wake");
  const repeated = await h.driver.drive(h.input);
  assert.equal(repeated.wakeAt, undefined);
  assert.equal(h.requests.length, 1);
  await h.driver.drive(h.input);
  assert.equal(h.requests.length, 1);
  const loaded = await createBoardReader(h.boardRoot).load();
  assert.ok(loaded.ok);
  const root = loaded.state.centralLearningBudgets?.find(row => row.scope === scope);
  assert.ok(root);
  const adjusted = await withBoardWriter(h.boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "user:explicit-budget-increase", issuedAt: now(),
    action: { kind: "set_budget_limit", budgetId: root.budgetId, expectedSequence: loaded.state.sequence, changeId: "user:increase",
      limits: { ...root.limits, tokens: root.limits.tokens + 1000 }, authorizationRef: "user:explicit-increase" } }));
  assert.ok(adjusted.ok, JSON.stringify(adjusted));
  const input = { ...h.input, configuration: { ...h.input.configuration, rootRef: { budgetId: root.budgetId, scope: root.scope,
    openedSequence: root.openedSequence, authorizationRef: root.authorizationRef } } };

  assert.equal((await h.driver.drive(input)).state, "waiting");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]?.configuration.configurationRef, configuration.configurationRef, "a mere new configuration label is not the trigger used by this test");
  assert.equal(h.requests[1]?.resources.limits.tokens, root.limits.tokens + 1000);
  await h.driver.drive(input);
  assert.equal(h.requests.length, 2);
  await h.driver.close?.();
});

function derivedCentralIntent(quote: string): CentralLearningIntentDraft {
  const questionRef = "central-question:condition";
  return { ...intent({ kind: "ready", operation: operation("central:read-derived", "read") }), intentId: questionRef,
    subject: { plane: "central", questionRef }, derivation: { relation: "The known method may depend on the condition described in the source",
      whenRelevant: "Before generalizing the method to the changed condition", parentRefs: [sourceRef], citations: [{ evidenceRef: sourceRef, quote }] } };
}

test("a central goal derives from actually read material without requiring a pre-existing subsystem opportunity", async t => {
  const h = await harness(t, () => output([derivedCentralIntent(sourceMaterial.text)]), {}, { snapshot: snapshot => ({ ...snapshot, opportunities: [] }) });
  assert.equal((await h.driver.drive(h.input)).state, "ready");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.opportunities.length, 0);
  assert.equal(h.requests[0]?.materials[0]?.ref, sourceRef);
  assert.equal((await h.state()).state.intents[0]?.subject.plane, "central");
  assert.equal((await h.driver.drive(h.input)).state, "ready");
  assert.equal(h.sourceReads.length, 1);
  await h.driver.close?.();
});

test("a new central goal cannot cite an unread or invented quote as its grounding", async t => {
  const h = await harness(t, () => output([derivedCentralIntent("This exact quote was never in the supplied material")]), {},
    { snapshot: snapshot => ({ ...snapshot, opportunities: [] }) });
  await refusal(h.driver.drive(h.input), /central_derived_intent_citation_unread_or_not_unique/);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.state()).state.intents.length, 0);
  assert.equal(h.sourceReads.length, 0);
  await h.driver.close?.();
});

test("a domain resource wait is persisted without a paid interpretation or a duplicate-wake semantic call", async t => {
  const returned = deferred<CentralLearningDriverProgress>();
  const wait = { kind: "resources" as const, reason: "Original root resources cannot fund this receiver stage", sourceRefs: ["budget:original-root"] };
  const h = await harness(t, (_request, index) => {
    assert.equal(index, 1, "a typed resource receipt does not require another paid thought to understand it");
    return output([intent({ kind: "ready", operation: operation("op:resource-wait-worker", "dispatch") })]);
  }, { async execute() { return { outcome: "unknown", wait, publicResult: "The original receiver is waiting for actual resources.", resultRefs: ["receipt:resources"] }; } });
  const input = { ...h.input, publish(value: CentralLearningDriverProgress) {
    h.published.push(value);
    returned.resolve(value);
  } };

  assert.equal((await h.driver.drive(input)).state, "ready");
  assert.equal((await h.driver.drive(input)).state, "waiting");
  const published = await returned.promise;
  assert.equal(published.state, "waiting");
  assert.equal(published.wakeAt, undefined);
  const saved = await h.state(), current = saved.state.intents.find(row => row.intentId === "intent:original");

  assert.equal(current?.continuation.kind, "waiting");

  if (current?.continuation.kind === "waiting") assert.deepEqual(current.continuation.wait, wait);

  assert.deepEqual(saved.state.completed.find(row => row.operation.operationId === "op:resource-wait-worker")?.wait, wait);
  await h.driver.drive(input);
  await h.driver.drive({ ...input, wake: { reason: "duplicate_resource_status", sourceRefs: ["receipt:resources"] } });
  assert.equal(h.requests.length, 1);
  assert.equal(h.sourceReads.length, 0);
  assert.equal((await h.state()).state.intents.some(row => row.continuation.kind === "ready" && row.continuation.operation.kind === "think"), false);
  await h.driver.close?.();
});

test("a cited snapshot fragment survives central dispatch preparation and exact canonical archive read", async t => {
  const h = await harness(t, () => { throw new Error("unused_harness_semantic"); });
  await h.driver.close?.();
  const store = createCentralRuntimeStore({ boardRoot: h.boardRoot, enabled: () => true });
  const canonical = createCentralRuntimeSource({ boardRoot: h.boardRoot, scope, ports: [], enabled: () => true });
  const full = (await canonical.read(scope, [sourceRef], 8192, h.input.signal))[0];
  assert.ok(full);
  const offset = full.text.indexOf(sourceMaterial.text);
  assert.ok(offset > 0);
  const address = `central-runtime-page:${offset}:${encodeURIComponent(full.ref)}`;
  const page = (await canonical.read(scope, [address], 1024, h.input.signal))[0];
  assert.ok(page);
  assert.ok(page.ref.startsWith("central-runtime-fragment:"));
  assert.ok(page.text.includes(sourceMaterial.text));
  assert.equal((await store.read(scope)).state.materials.length, 0);
  assert.equal((await store.lookup(scope, { kind: "material", ref: page.ref })).status, "missing", "the citation is not pre-injected into runtime state or archive");
  const peer: CentralRuntimeSourcePort = { async snapshot() {
    const loaded = await createBoardReader(h.boardRoot).load();
    assert.ok(loaded.ok);
    return { boardSequence: loaded.state.sequence, opportunities: [], materials: [page], sourceRefs: [page.ref] };
  }, async read() { throw new Error("archive_read_must_not_recontact_the_original_page_owner"); } };
  const source = createCentralRuntimeSource({ boardRoot: h.boardRoot, scope, ports: [], enabled: () => true, peerSources: [peer] });
  let prepared = 0, deliberated = 0;
  const returned = deferred<void>();
  const driver = createCentralLearningDriver({ boardRoot: h.boardRoot, scope, enabled: () => true, now, source,
    deliberation: { async deliberate(request) {
      deliberated += 1;
      assert.ok(request.materials.some(row => row.ref === page.ref && row.text === page.text));
      const questionRef = "central-question:actual-fragment";
      const dispatch = { ...operation("op:dispatch-snapshot-fragment", "dispatch"), sourceRefs: [page.ref], destination: { plane: "agent" as const, domain: "prompt" as const } };

      return { schemaVersion: 1, publicExplanation: "Study the condition in the actual original fragment", sourceRefs: [page.ref], intents: [{
        ...intent({ kind: "ready", operation: dispatch }), intentId: questionRef, subject: { plane: "central", questionRef }, sourceRefs: [page.ref],
        derivation: { relation: "The original condition differs from the method's prior support", whenRelevant: "Before transferring the method",
          parentRefs: [page.ref], citations: [{ evidenceRef: page.ref, quote: sourceMaterial.text }] } }] };
    } }, execution: { ...h.execution, async prepare(input) {
      prepared += 1;
      assert.equal(input.intent.subject.plane, "central");
      const saved = await store.read(scope), live = saved.state.materials.find(row => row.ref === page.ref);
      const archived = live === undefined ? await store.lookup(scope, { kind: "material", ref: page.ref }) : undefined;
      const actual = live ?? (archived?.status === "found" && "text" in archived.value ? archived.value : undefined);
      assert.ok(actual, "a dispatched citation must retain its actually delivered original body");
      assert.deepEqual(actual, page);
      return { intentId: input.intent.intentId, operation: input.operation, workRef: "work:snapshot-fragment", frame: { sourceRef: page.ref } };
    }, async execute() { return { outcome: "unknown", wait: { kind: "resources", reason: "The receiver requires original funding", sourceRefs: ["budget:receiver"] },
      publicResult: "The original receiver handed back a resource wait", resultRefs: ["receipt:snapshot-fragment"] }; } } });
  const input = { ...h.input, publish() { returned.resolve(); } };

  assert.equal((await driver.drive(input)).state, "ready");
  assert.equal((await driver.drive(input)).state, "waiting");
  await returned.promise;
  assert.equal(prepared, 1);
  assert.equal(deliberated, 1);
  const before = await store.read(scope);
  assert.equal((await store.append({ expectedRevision: before.revision, previousRef: before.stateRef,
    state: { ...before.state, materials: [] }, reason: "Compact only already archived delivered material", sourceRefs: [page.ref] })).status, "written");
  const fresh = createCentralRuntimeSource({ boardRoot: h.boardRoot, scope, ports: [], enabled: () => true });

  assert.deepEqual(await fresh.read(scope, [page.ref], 8192, h.input.signal), [page], "the exact fragment hash ref resolves to the original archived body");
  await driver.close?.();
});

test("ordinary reconsideration keeps the live work signal and explicit investment end cancels it without late revival", async t => {
  for (const outcome of ["unknown", "returned"] as const) {
    let stage: "initial" | "continue" | "end" = "initial", workSignal: AbortSignal | undefined;
    const started = deferred<void>(), release = deferred<CentralRuntimeWorkResult>(), published = deferred<void>();
    const h = await harness(t, (request, index) => {
      if (index === 1) return output([intent({ kind: "ready", operation: operation("operation:live-lifecycle", "dispatch") })]);

      if (index === 2) {
        const waiting = request.state.intents.find(row => row.intentId === "intent:original");
        assert.ok(waiting);
        assert.equal(waiting.continuation.kind, "waiting");
        if (waiting.continuation.kind === "waiting") assert.deepEqual(waiting.continuation.wait.sourceRefs, ["work:one"]);
        return output([waiting]);
      }

      assert.equal(index, 3);
      return output([intent({ kind: "ended", goalState: "open", reason: "Stop this investment while retaining its unanswered question" },
        "The source owner explicitly ended this investment")]);
    }, { execute(_work, signal) {
      workSignal = signal;
      started.resolve();
      return release.promise;
    } }, {
      snapshot: snapshot => stage === "initial" ? snapshot : changedSnapshot(snapshot, `feedback:lifecycle-${stage}`, true),
    });
    const input = { ...h.input, publish(value: CentralLearningDriverProgress) {
      h.published.push(value);
      published.resolve();
    } };

    await h.driver.drive(input);
    await h.driver.drive(input);
    await started.promise;

    try {
      assert.ok(workSignal);
      assert.equal(workSignal.aborted, false);
      await sourceFact(h.boardRoot, "feedback:lifecycle-continue");
      stage = "continue";
      assert.equal((await h.driver.drive(input)).state, "waiting");
      assert.equal(h.requests.length, 2);
      assert.equal(workSignal.aborted, false, "ordinary related reconsideration is not a cancellation decision");
      const live = await h.state();
      assert.equal(live.state.running.length, 1);
      const waiting = live.state.intents[0];
      assert.equal(waiting?.continuation.kind, "waiting");

      if (waiting?.continuation.kind === "waiting") assert.deepEqual(waiting.continuation.wait.sourceRefs, ["work:one"], "the exact original wait ref survives without an invented alias");

      await sourceFact(h.boardRoot, "feedback:lifecycle-end");
      stage = "end";
      await h.driver.drive(input);
      assert.equal(h.requests.length, 3);
      assert.equal(workSignal.aborted, true, "only the explicit end retires the original in-memory worker");
    } finally {
      release.resolve({ outcome, publicResult: `Late ${outcome} after the investment ended`, resultRefs: [`receipt:late-${outcome}`] });
    }

    await published.promise;
    const after = await h.state();
    assert.equal(after.state.running.length, 0);
    assert.ok(after.state.intents.every(row => row.intentId !== "intent:original" || row.continuation.kind === "ended"));
    const archived = await createCentralRuntimeStore({ boardRoot: h.boardRoot, enabled: () => true }).lookup(scope, { kind: "ended_intent", intentId: "intent:original" });

    assert.equal(archived.status, "found");

    if (archived.status === "found") {
      assert.ok("continuation" in archived.value);
      assert.equal(archived.value.continuation.kind, "ended");
    }

    assert.equal(h.requests.length, 3);
    await h.driver.close?.();
  }
});
