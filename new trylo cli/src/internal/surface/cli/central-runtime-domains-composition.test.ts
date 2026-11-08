import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningConfiguration, CentralLearningIntentDraft, CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { successfulDomainResponse } from "../../integration/central-learning/testing/domain-funding.test.js";
import { searchImprovementFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import { createWorkflowImprovementFunding } from "../../learning/agent/subsystems/workflow/adapters/improvement-funding.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import type { WorkflowResearchFinding } from "../../learning/agent/subsystems/workflow/improvement/research-contracts.js";
import type { CliContext } from "./context.js";
import { createCentralRuntimeDomains, type CentralRuntimeDomainsInput } from "./central-runtime-domains.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./wiring-catalog.js";

const now = "2026-11-05T18:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 64000, maxCalls: 8, maxSteps: 8, maxPromptChars: 24000 };
const signal = () => new AbortController().signal;

/** Only transport is scripted. Each fork is a different provider instance and
 * all five domain factories, original stores and workers remain real. */
function isolatedProvider(output: (request: ProviderRequest, call: number) => unknown) {
  const requests: ProviderRequest[] = [];
  let forks = 0;
  const instance = (): ProviderPort => ({
    async *stream(request) {
      const call = requests.length;
      requests.push(request);
      yield* successfulDomainResponse(output(request, call));
    },

    fork: () => {
      forks += 1;
      return instance();
    },
  });

  return { provider: instance(), requests, forks: () => forks };
}

async function fixture(t: TestContext, output: Parameters<typeof isolatedProvider>[0] = () => {
  throw new Error("A composition/preparation contract must not send a model request");
}) {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-domain-composition-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-domain-composition-/);
    await rm(root, { recursive: true, force: true });
  });
  const scope = path.join(root, "workspace");
  await mkdir(scope);
  let id = 0, enabled = true, contextReads = 0;
  const warnings: string[] = [];
  const unexpected = (): never => { throw new Error("Independent research must not open business input or execute host writes"); };
  const ctx: CliContext = { homeDir: root, cwd: scope, env: { TRYLO_HOME: path.join(root, "profile") },
    nodeVersion: "v24", stdinIsTty: false, readFile: () => undefined, readDir: () => [], isDirectory: () => false,
    writeFile: unexpected, readLine: unexpected, readSecret: unexpected, readStdin: unexpected, stdout: unexpected,
    stderr: value => { warnings.push(value); }, now: () => Date.parse(now), newId: prefix => `${prefix}:${++id}` };
  const transport = isolatedProvider(output), boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), workspaceId = workspaceIdentity(scope);
  const context = { ref: "test-only:original-workflow-purpose",
    text: "Explain why owner evidence is discarded, preserve complete source checks, and retain the conditional understanding for later work." };
  const input: CentralRuntimeDomainsInput = { ctx, boardRoot, scope, workspaceId, provider: transport.provider,
    model: "scripted-scope-transport", modelRef: "test-only:scripted-scope-transport", allowance,
    authorizationRef: "test-only:independent-domain-envelope", enabled: () => enabled,

    contextForIssue: async () => {
      contextReads += 1;
      return context;
    },

    connection: { providerId: "test-only:explicit-connection", providerKind: "openai-compatible", model: "scripted-scope-transport",
      endpoint: "https://example.invalid/v1", apiKey: undefined, provider: transport.provider, permissionChoice: {} } };
  const load = async () => {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  };

  return { root, ctx, scope, workspaceId, boardRoot, input, context, transport, warnings, load,
    disable: () => { enabled = false; }, enable: () => { enabled = true; }, contextReads: () => contextReads };
}

async function sourceAndBudget(h: Awaited<ReturnType<typeof fixture>>) {
  const fixtureSource = searchImprovementFixture();
  const source = { ...fixtureSource, opportunity: { ...fixtureSource.opportunity,
    task: { ...fixtureSource.opportunity.task, scope: h.workspaceId } } };
  const original = createWorkflowImprovementFunding({ boardRoot: h.boardRoot, scope: h.workspaceId, centralScope: h.scope,
    budgetId: "test-only:source-nomination", allowance: allowance.maxTokens, research: true, now: h.ctx.now });
  const nominated = await original.prepare({ type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: source.opportunity, evidence: source.evidence });

  assert.ok(nominated.ok, JSON.stringify(nominated));
  const before = await h.load();

  assert.equal(before.centralLearningGrants?.length ?? 0, 0, "source preparation cannot create an independent grant");
  const opened = await withBoardWriter(h.boardRoot, board => board.apply({ type: "coordinate_learning",
    commandId: "test-only:composition-root", issuedAt: now, action: { kind: "open_budget", expectedSequence: before.sequence,
      budget: { schemaVersion: 1, budgetId: "test-only:composition-root", scope: h.scope, unit: "total_model_tokens",
        limits: { tokens: allowance.maxTokens, calls: allowance.maxCalls, steps: allowance.maxSteps },
        authorizationRef: h.input.authorizationRef } } }));

  assert.ok(opened.ok, JSON.stringify(opened));
  const operation: Extract<CentralLearningOperation, { kind: "dispatch" }> = { kind: "dispatch", operationId: "test-only:workflow-investigation",
    purpose: "Understand the repeated source-navigation waste", expectedChange: "A conditional public finding and a grounded process proposal",
    sourceRefs: [nominated.value.inputVersionId], allowance: { ...allowance, maxTokens: 32000, maxCalls: 4, maxSteps: 4 } };
  const intent: CentralLearningIntentDraft = { intentId: "test-only:workflow-purpose", subject: { plane: "agent", domain: "workflow", issueId: nominated.value.issueId },
    goal: "Reduce repeated discarded source searches while preserving complete evidence", rationale: "The real saved source records repeated broad searches",
    conditions: ["The repository owner remains identifiable"], knowledge: [], residual: ["Which condition permits reuse?"],
    commitment: { purpose: operation.purpose, assumptions: [], reconsiderWhen: ["The owner or source checks change"] },
    revisionReason: "Begin original-source research", sourceRefs: operation.sourceRefs, continuation: { kind: "ready", operation } };
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "test-only:composition-configuration",
    authorizationRef: h.input.authorizationRef, allowance };

  return { source, operation, intent, configuration };
}

test("scope-owned composition constructs all five real domain ports without model calls or business execution", async t => {
  const h = await fixture(t), runtime = createCentralRuntimeDomains(h.input);
  t.after(() => runtime.close());
  assert.deepEqual(runtime.ports.map(port => port.domain).sort(), ["collaboration", "prompt", "skill", "tool", "workflow"]);
  assert.equal(h.transport.requests.length, 0);
  assert.ok(h.transport.forks() >= 2);
  const before = await h.load();

  assert.deepEqual(await runtime.nominate(signal()), []);
  const after = await h.load();

  assert.equal(after.sequence, before.sequence);
  assert.equal(after.jobs.length, 0);
  assert.equal(after.assets.length, 0);
  assert.equal(h.contextReads(), 0);
  assert.equal(h.transport.requests.length, 0);
  assert.deepEqual(h.warnings, []);
});

test("scope, Board and workspace mismatches fail before any domain/model construction", async t => {
  const h = await fixture(t);

  for (const input of [{ ...h.input, scope: path.join(h.scope, "other") },
    { ...h.input, boardRoot: path.join(h.boardRoot, "other") }, { ...h.input, workspaceId: "test-only:wrong-workspace" }]) {
    assert.throws(() => createCentralRuntimeDomains(input), /central_runtime_domain_owner_mismatch/);
  }

  assert.equal(h.transport.forks(), 0);
  assert.equal(h.transport.requests.length, 0);
  assert.equal((await h.load()).sequence, 0);
});

test("a proven physical alias preserves the original domain ID without admitting a foreign root", { skip: path.sep !== "\\" }, async t => {
  const h = await fixture(t), primary = h.scope.toUpperCase(), workspaceId = workspaceIdentity(primary);
  const identity = { physicalRoot: realpathSync.native(h.scope), workspaceRoot: primary, workspaceId,
    budgetScope: h.scope, compatibleRoots: [primary, h.scope], compatibleWorkspaceIds: [workspaceId, h.workspaceId] };
  const ctx = { ...h.ctx, realPath: (root: string) => realpathSync.native(root), workspaceIdentity: identity };
  const runtime = createCentralRuntimeDomains({ ...h.input, ctx, workspaceId });

  assert.equal(runtime.ports.length, 5);
  await runtime.close();
  const foreign = path.join(h.root, "foreign");
  await mkdir(foreign);
  const foreignId = workspaceIdentity(foreign);

  assert.throws(() => createCentralRuntimeDomains({ ...h.input, workspaceId: foreignId,
    ctx: { ...ctx, workspaceIdentity: { ...identity, workspaceRoot: foreign, workspaceId: foreignId } } }),
  /central_runtime_domain_owner_mismatch/);
  assert.equal((await h.load()).sequence, 0);
  assert.equal(h.transport.requests.length, 0);
});

test("disabled and closed owners cannot dispatch prepared real workflow research or refresh its sources", async t => {
  const h = await fixture(t), original = await sourceAndBudget(h), runtime = createCentralRuntimeDomains(h.input);
  t.after(() => runtime.close());
  const input = { scope: h.scope, ...original, signal: signal() };
  const work = await runtime.execution.prepare(input);

  assert.equal(h.transport.requests.length, 0);
  const before = await h.load(), reads = h.contextReads();
  h.disable();
  await assert.rejects(runtime.execution.execute(work, signal()), /central_runtime_learning_inactive/);
  await assert.rejects(runtime.execution.prepare(input), /central_runtime_learning_inactive/);
  assert.deepEqual(await runtime.nominate(signal()), []);
  const workflow = runtime.ports.find(port => port.domain === "workflow")!;

  assert.equal((await workflow.prepare({ issueId: original.intent.subject.plane === "agent" ? original.intent.subject.issueId : "",
    authorizedAllowance: allowance }, signal())).status, "unavailable");
  assert.equal(h.contextReads(), reads);
  assert.deepEqual(await h.load(), before);
  await runtime.close();
  h.enable();
  await assert.rejects(runtime.execution.execute(work, signal()), /central_runtime_learning_inactive/);
  assert.equal(h.transport.requests.length, 0);
});

test("the total composition carries original context into real multistep workflow research and preserves a public finding", async t => {
  const raw = searchImprovementFixture();
  const finding: WorkflowResearchFinding = { kind: "interpretation", statement: "Discarding located owner evidence can cause repeated broad searches.",
    conditions: "The located owner still exists in the current repository snapshot.", sourceRefs: raw.opportunity.evidenceRefs,
    nextQuestion: "Does owner reuse preserve source completeness in later work?" };
  const actions = [{ kind: "read_material", evidenceRefs: finding.sourceRefs }, { kind: "record_finding", finding },
    { kind: "propose", proposal: raw.proposal }];
  const h = await fixture(t, (_request, call) => {
    assert.ok(call < actions.length, "The original worker must not add an unrequested model retry");
    return actions[call];
  });
  const original = await sourceAndBudget(h), runtime = createCentralRuntimeDomains(h.input);
  t.after(() => runtime.close());
  const work = await runtime.execution.prepare({ scope: h.scope, intent: original.intent, operation: original.operation,
    configuration: original.configuration, signal: signal() });

  assert.equal(h.transport.requests.length, 0, "actual original-source preparation must not send a provider request");
  const result = await runtime.execution.execute(work, signal());

  assert.equal(result.outcome, "returned", result.publicResult);
  assert.match(result.publicResult, /goalCompletion.*unknown/);
  assert.equal(h.transport.requests.length, 3);
  const material = h.transport.requests.map(request => JSON.parse(request.messages.find(message => message.role === "user")!.content));

  assert.ok(h.contextReads() > 0);
  assert.ok(material.every(item => JSON.stringify(item.currentMaterial.centralContent) === JSON.stringify(h.context)));
  assert.deepEqual(material[0].currentMaterial.evidence, []);
  assert.deepEqual(material[1].currentMaterial.evidence.map((item: { ref: string }) => item.ref), [...finding.sourceRefs]);
  assert.deepEqual(material[2].recentFindings[0].finding, finding);
  assert.ok(h.transport.requests.every(request => request.model === h.input.model && request.tools.length === 0));
  const state = await h.load(), view = workflowImprovementsFromBoard(state, h.workspaceId, h.scope);
  assert.ok(view.ok);
  assert.equal(state.centralLearningBudgets?.length, 1);
  assert.equal(state.centralLearningGrants?.length, 1);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 4500, calls: 3, steps: 3 });
  assert.equal(view.value.versions.length, 1);
  assert.equal(view.value.versions[0]!.status, "eligible");
  assert.equal(view.value.research?.length, 3);
  const record = view.value.research!.find(item => item.record.status === "continue" && item.record.observation.kind === "finding_recorded");

  assert.ok(record);
  if (record.record.status === "continue" && record.record.observation.kind === "finding_recorded") {
    assert.deepEqual(record.record.observation.finding, finding);
  }

  assert.equal(state.activations.length, 0);
  assert.equal(view.value.uses.length, 0, "proposal delivery does not fabricate downstream adoption");
  const sent = h.transport.requests.length;
  const recovered = await runtime.execution.recover(work, signal());

  assert.ok(recovered !== null && "outcome" in recovered);
  assert.equal(recovered.outcome, "returned");
  assert.equal(h.transport.requests.length, sent, "read-only recovery must not repeat research");
});

test("same scope composition consult follows the exact live root after explicit limit increases and decreases", async t => {
  const h = await fixture(t), original = await sourceAndBudget(h);
  const root = (await h.load()).centralLearningBudgets!.find(item => item.scope === h.scope)!;
  const rootRef = { budgetId: root.budgetId, scope: root.scope, openedSequence: root.openedSequence,
    authorizationRef: root.authorizationRef };
  const runtime = createCentralRuntimeDomains({ ...h.input, rootRef });
  t.after(() => runtime.close());
  const setLimit = async (changeId: string, tokens: number, calls: number) => {
    const before = await h.load();
    const changed = await withBoardWriter(h.boardRoot, board => board.apply({ type: "coordinate_learning",
      commandId: `test-only:root-limit:${changeId}`, issuedAt: now, action: { kind: "set_budget_limit",
        budgetId: root.budgetId, expectedSequence: before.sequence, changeId, limits: { tokens, calls, steps: calls },
        authorizationRef: `test-only:explicit-root-limit:${changeId}` } }));
    assert.ok(changed.ok, JSON.stringify(changed));
  };
  const expanded = { ...allowance, maxTokens: 80000, maxCalls: 9, maxSteps: 9 };
  const consult = (requested: typeof allowance) => runtime.execution.consult({ scope: h.scope,
    subject: original.intent.subject, allowance: requested, signal: signal() });

  await setLimit("increase", 128000, 12);
  const increased = JSON.parse((await consult(expanded)).text);

  assert.deepEqual(increased.incrementalAllowance, expanded);
  assert.deepEqual(increased.unavailable, [], "an exact-root consultation can exceed the construction-time envelope");
  await setLimit("decrease", allowance.maxTokens, 4);
  await assert.rejects(consult(expanded), /central_runtime_agent_lifetime_authorization_exhausted/);
  const reduced = JSON.parse((await consult(original.operation.allowance)).text);

  assert.deepEqual(reduced.unavailable, [], "the same owner can consult within its newly reduced live root");
  const final = await h.load(), savedRoot = final.centralLearningBudgets!.find(item => item.budgetId === rootRef.budgetId)!;

  assert.equal(savedRoot.openedSequence, rootRef.openedSequence);
  assert.equal(savedRoot.authorizationRef, rootRef.authorizationRef);
  assert.equal(savedRoot.limitChanges?.length, 2);
  assert.equal(final.centralLearningGrants?.length ?? 0, 0, "consultation must not fund another grant");
  assert.equal(h.transport.requests.length, 0);
});
