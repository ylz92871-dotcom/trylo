import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { canonicalJson } from "../../../../control/hash.js";
import { acceptCentralToolResearch } from "./central-research-intake.js";
import { createToolCentralLearning } from "./central-learning.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import { planForJob, resultForJob } from "./pipeline-records.js";

const at = "2026-11-05T01:00:00.000Z", scope = "workspace:tool-research", workspaceId = "legacy:tool-research";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 10000, maxCalls: 2, maxSteps: 2, maxPromptChars: 12000 };
const operation = { kind: "dispatch" as const, operationId: "op:tool-research", purpose: "Compare tool failure recovery",
  expectedChange: "A better investigation procedure", sourceRefs: ["source:tool-business"], allowance,
  destination: { plane: "agent" as const, domain: "tool" as const } };
const request: GroundedCentralResearch = { requestRef: "request:tool-research", domain: "tool", operation,
  intent: { intentId: "intent:tool-research", subject: { plane: "central", questionRef: "intent:tool-research" },
    goal: "Learn reusable recovery from repeated tool contract failures", rationale: "Solved tasks exposed a common tool limitation",
    conditions: ["structured tool outputs"], knowledge: [{ statement: "Retries did not fix mismatched contracts", conditions: "Same argument schema",
      sourceRefs: ["source:tool-business"] }], residual: ["What should the tool planner inspect first?"],
    commitment: { purpose: "Find reusable recovery", assumptions: ["Original business task is solved"], reconsiderWhen: ["Tool contract changes"] },
    revisionReason: "New comparative purpose", sourceRefs: ["source:tool-business"], continuation: { kind: "ready", operation } },
  materials: [{ ref: "source:tool-business", kind: "source", text: "Two solved tasks required correcting tool arguments after repeated failures.", sourceRefs: [] }],
  sourceRefs: ["source:tool-business"] };

test("central tool purpose creates one truthful native plan and reaches the funded original pipeline", async t => {
  const root = await mkdtemp(testScratchPath("central-tool-research-"));

  t.after(async () => {
    assert.ok(root.startsWith(testScratchPath() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const options = { boardRoot: root, scope, workspaceId, now: () => Date.parse(at), enabled: () => true };
  const signal = new AbortController().signal;
  const receptions = await Promise.all([acceptCentralToolResearch(options, request, signal),
    acceptCentralToolResearch({ ...options, now: () => Date.parse(at) + 1000 }, request, signal)]);
  const accepted = receptions.find(row => row.status === "accepted");
  assert.ok(accepted?.status === "accepted", JSON.stringify(receptions));
  assert.ok(receptions.every(row => row.status === "accepted" || row.reason === "multi_writer"));
  const repeated = await acceptCentralToolResearch({ ...options, now: () => Date.parse(at) + 1000 }, request, signal);
  assert.deepEqual(repeated, accepted);
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  let serial = 0;
  const apply = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `test:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const initial = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;

  assert.ok("subsystem" in initial.reports[0]!.source && initial.reports[0]!.source.subsystem === "tool");
  const jobId = "versionId" in initial.reports[0]!.source ? initial.reports[0]!.source.versionId : "";
  const plan = planForJob(await load(), jobId);
  assert.ok(plan);
  assert.equal(plan.trigger.action, "central_research");
  assert.equal(plan.trigger.proposalKey, request.requestRef);
  assert.ok(initial.reports[0]!.evidenceRefs.includes(request.intent.intentId));
  await apply({ kind: "decide", issueId: initial.issueId, expectedRevision: initial.revision, decision: "focused_learning", reason: "Test authorized tool research", sourceRefs: request.sourceRefs });
  await apply({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1,
    budgetId: "budget:tool-research", scope, unit: "total_model_tokens", limits: { tokens: 20000, calls: 4, steps: 4 }, authorizationRef: "test:explicit" } });
  let plans = 0;
  const context = { ref: "context:tool-intent", text: canonicalJson({ intent: request.intent, materials: request.materials }) };
  const owner = createToolCentralLearning({ boardRoot: root, scope: workspaceId, centralScope: scope, now: options.now,
    authorized: () => true, modelRef: "scripted-tool", mode: "manual", contextForIssue: async () => context,
    run: async (selected, binding, abort) => {
      const funding = createToolLearningFunding({ boardRoot: root, scope: workspaceId, centralScope: scope,
        now: options.now, managedBinding: binding });
      return workToolLearningPipeline({ boardRoot: root, scope: workspaceId, now: options.now, mode: "manual", signal: abort,
        jobIds: [selected], services: { ...(binding.centralSourceContext === undefined ? {} : { centralSourceContext: binding.centralSourceContext }),
          allowance: plan => funding.allowance(plan), releaseAllowance: () => funding.release(),
          search: async () => { throw new Error("No public search requested"); }, evolve: async () => { throw new Error("No construction requested"); },
          plan: async context => {
            plans += 1;
            assert.equal(context.plan.trigger.action, "central_research");
            assert.ok(context.centralSourceContext?.text.includes(request.intent.goal));
            assert.ok(context.centralSourceContext?.text.includes(request.intent.knowledge[0]!.statement));
            assert.ok((await funding.reserve("test:tool-planning-call", 1000)).ok);
            assert.ok((await funding.settle("test:tool-planning-call", { kind: "reported", totalTokens: 100, model: "scripted-tool" })).ok);

            return { action: "defer", reason: "more_evidence", neededEvidence: ["An authoritative tool contract"],
              rationale: "The source shows contract mismatch", existingInsufficiency: "Contract is unknown", expectedBenefit: "Avoid blind retries",
              constructionCost: "No construction", alternatives: ["Inspect the authoritative contract"] };
          } } });
    } });
  const quoted = await owner.prepare({ issueId: accepted.issueId, authorizedAllowance: allowance }, signal);
  assert.ok(quoted.status === "ready", JSON.stringify(quoted));
  const before = await load(), focused = before.learningIssues!.find(row => row.issueId === accepted.issueId)!;

  await apply({ kind: "fund", domain: "tool", issueId: focused.issueId, expectedRevision: focused.revision, grantId: quoted.source.grantId,
    allowance, budgetId: "budget:tool-research", authorizationRef: "test:explicit", planRef: "test:plan", expectedSequence: before.sequence });
  const issue = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;
  const result = await owner.dispatch({ issueId: issue.issueId, grantId: quoted.source.grantId, expectedIssueRevision: issue.revision,
    stageRef: quoted.stageRef, policyRef: quoted.policyRef, sourceBindingRef: quoted.source.sourceBindingRef, offer: quoted.offer }, signal);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(plans, 1);
  const board = await load(), native = board.jobs.find(row => row.jobId === jobId)!;

  assert.equal(native.state, "waiting_evidence");
  assert.equal(resultForJob(board, jobId, native.attempt)?.code, "more_evidence");
  assert.equal(board.centralLearningGrants!.length, 1);
  assert.equal(board.centralLearningGrants![0]!.reservations.length, 1);
});
