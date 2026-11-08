import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createLearningAllocationApplication } from "../../integration/learning-allocation/application.js";
import type { CentralFundedStage, CentralStagePreparation } from "../../integration/central-learning/contracts.js";
import { domainProvider, successfulDomainResponse } from "../../integration/central-learning/testing/domain-funding.test.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CliContext } from "./context.js";
import { createCentralRuntimeCollaboration } from "./central-runtime-collaboration.js";
import { createCentralRuntimeSkill } from "./central-runtime-skill.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import type { SkillDailyConnection } from "./skill-daily-provider.js";

const at = "2026-11-05T12:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 20000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };
const signal = () => new AbortController().signal;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-independent-domains-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-independent-domains-/);
    await rm(root, { recursive: true, force: true });
  });
  const scope = path.join(root, "workspace");
  await mkdir(scope);
  let id = 0;
  const unexpected = (): never => { throw new Error("An independent domain must not use business input or tools"); };
  const ctx: CliContext = { homeDir: root, cwd: scope, env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24", stdinIsTty: false, readFile: () => undefined, readDir: () => [], isDirectory: () => false,
    writeFile: unexpected, readLine: unexpected, readSecret: unexpected, readStdin: unexpected,
    stdout: unexpected, stderr: unexpected, now: () => Date.parse(at), newId: prefix => `${prefix}-${++id}` };
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const load = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const fund = async (prepared: CentralStagePreparation): Promise<CentralFundedStage> => {
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") throw new Error("Expected a real original-domain stage");

    const opened = await withBoardWriter(boardRoot, async store => store.apply({ type: "coordinate_learning", commandId: "test:open-root",
      issuedAt: at, action: { kind: "open_budget", expectedSequence: (await load()).sequence,
        budget: { schemaVersion: 1, budgetId: "root:test", scope, unit: "total_model_tokens",
          limits: { tokens: 20000, calls: 2, steps: 2 }, authorizationRef: "test-only:root" } } }));

    assert.ok(opened.ok);
    const state = await load(), budget = centralBudgetProjection(state, "root:test")!;
    const issue = state.learningIssues!.find(item => item.issueId === prepared.source.issueId)!;
    const app = createLearningAllocationApplication({ boardRoot, now: () => at, enabled: () => true });
    const committed = await app.commit({ kind: "portfolio", authorizationRef: "test-only:domain-stage",
      proposalJson: JSON.stringify({ schemaVersion: 1, basis: { scope, boardSequence: state.sequence, budgetId: budget.budget.budgetId,
        utilityUnit: "test-only-delivery", valuationRef: "test-only:original-domain" }, unit: "total_model_tokens", domainRelation: "separable",
        budget: budget.available, groups: [{ owner: prepared.offer.owner, tiers: [{ quota: 1, netValue: 1, offer: prepared.offer }] }] }),
      bindingsJson: JSON.stringify([{ offerId: prepared.offer.offerId, offerHash: contentHashOf(prepared.offer), policyRef: prepared.policyRef,
        sourceBindingRef: prepared.source.sourceBindingRef, authorizedAllowance: prepared.authorizedAllowance,
        issueId: issue.issueId, expectedIssueRevision: issue.revision, grantId: prepared.source.grantId,
        mode: "fund", chargedAtBasis: { tokens: 0, calls: 0, steps: 0 } }]) });

    assert.equal(committed.status, "committed", JSON.stringify(committed));

    return { issueId: issue.issueId, grantId: prepared.source.grantId,
      expectedIssueRevision: (await load()).learningIssues!.find(item => item.issueId === issue.issueId)!.revision,
      stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  };

  return { ctx, scope, boardRoot, load, fund };
}

test("independent collaboration reaches its original worker after the source team ends, retaining its question and single root", async t => {
  const h = await fixture(t), reportId = "report:original-business-handoff";
  let round = 0;
  const transport = domainProvider(() => successfulDomainResponse(++round === 1
    ? { kind: "query", owner: "research", query: "https://example.invalid/original-handoff" }
    : { kind: "no_change", reason: "The original artifact reference needs a receiver observation before a reusable change is supported.", sourceRefs: [reportId] }));
  const context = { ref: "context:original-research-goal", text: "Investigate the missing artifact identity under the original handoff requirement." };
  const runtime = createCentralRuntimeCollaboration({ ...h, provider: transport.provider, model: "scripted-domain-model",
    modelRef: "test-only:scripted-domain-model", contextForIssue: async () => context, enabled: () => true });

  t.after(() => runtime.close());
  const reported = await runtime.control.report({ scope: h.scope, problemKey: "artifact-reference", report: {
    reportId, source: { teamRunId: "ended-team", taskId: "ended-task", memberId: "original-receiver" },
    facts: ["The handoff omitted the artifact version."], evidenceRefs: ["execution:original-handoff"] } });

  assert.ok(reported.ok);
  const focused = await runtime.control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Investigate the original report.", sourceRefs: [reportId] });

  assert.ok(focused.ok);
  const prepared = await runtime.port.prepare({ issueId: focused.issue.issueId, authorizedAllowance: allowance }, signal());

  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;

  assert.equal(prepared.condition?.features.selectedPopulation, "reported_owner_population_only");
  assert.equal(prepared.condition?.features.arrangement, undefined);
  const funded = await h.fund(prepared), result = await runtime.port.dispatch(funded, signal());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal((await runtime.port.observe(funded, signal())).outcome, "closed_no_result");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[0]!.tools, []);
  const prompt = JSON.parse(transport.requests[0]!.messages.find(message => message.role === "user")!.content);

  assert.deepEqual(prompt.material.centralContent, context);
  const state = await h.load();
  assert.equal(state.learningIssues!.length, 1);
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 3000, calls: 2, steps: 2 });
  assert.ok(state.collaborationRuntimeReceipts?.some(receipt => receipt.phase === "resource_result"
    && receipt.owner === "research" && receipt.status === "unavailable"), "missing web tools remain unavailable in the original resource receipt");
  assert.equal(state.assets.length, 0);
  assert.equal(state.activations.length, 0);
  await runtime.close();
  assert.equal((await runtime.port.prepare({ issueId: focused.issue.issueId, authorizedAllowance: allowance }, signal())).status, "unavailable");
});

test("independent collaboration rejects a divergent Board before constructing a second domain owner", async t => {
  const h = await fixture(t), transport = domainProvider(() => successfulDomainResponse({}));
  assert.throws(() => createCentralRuntimeCollaboration({ ...h, boardRoot: path.join(h.boardRoot, "other"),
    provider: transport.provider, model: "test-only", modelRef: "test-only", enabled: () => true }), /central_collaboration_board_root_mismatch/);
  assert.equal(transport.requests.length, 0);
});

test("independent Hermes scope refuses preparation when disabled or closed before using native review", async t => {
  const h = await fixture(t), transport = domainProvider(() => successfulDomainResponse({}));
  let enabled = false;
  const connection: SkillDailyConnection = { providerId: "test-only", providerKind: "openai-compatible", model: "selected-skill-model",
    endpoint: "https://example.invalid/v1", apiKey: undefined, provider: transport.provider, permissionChoice: {} };
  const runtime = createCentralRuntimeSkill({ ...h, provider: transport.provider, connection, enabled: () => enabled });

  t.after(() => runtime.close());
  const prepare = () => runtime.port.prepare({ issueId: "skill-issue:not-mounted", authorizedAllowance: allowance }, signal());

  assert.deepEqual(await prepare(), { status: "unavailable", reason: "collect_disabled", sourceRefs: [] });
  enabled = true;
  await runtime.close();
  assert.deepEqual(await prepare(), { status: "unavailable", reason: "collect_disabled", sourceRefs: [] });
  assert.equal(transport.requests.length, 0);
});

test("managed Hermes uses its supplied actual connection before reading original source, without resolving a different default", async t => {
  const h = await fixture(t), transport = domainProvider(() => successfulDomainResponse({}));
  const connection: SkillDailyConnection = { providerId: "test-only", providerKind: "openai-compatible", model: "selected-skill-model",
    endpoint: "https://example.invalid/v1", apiKey: undefined, provider: transport.provider, permissionChoice: {} };
  let sourceReads = 0;
  const dependencies = { boardRoot: h.boardRoot, provider: transport.provider, connection,

    opportunity: async () => {
      sourceReads += 1;
      return undefined;
    } };
  const runtime = createHermesSkillRuntime({ ...h.ctx, readFile: () => { throw new Error("unexpected_default_connection_resolution"); } },
    undefined, dependencies);
  t.after(() => runtime.close());
  const reported = await runtime.coordination.report({ taskId: "original-turn", sourceRef: "original-session",
    facts: ["An original skill source needs review."], evidenceRefs: ["original-source"] });

  assert.ok(reported.ok);
  const result = await runtime.prepareManaged(reported.issue.issueId, signal());

  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;

  assert.equal(result.reason, "hermes_skill_source_unavailable");
  assert.equal(sourceReads, 1);
  assert.equal(transport.requests.length, 0);
});
