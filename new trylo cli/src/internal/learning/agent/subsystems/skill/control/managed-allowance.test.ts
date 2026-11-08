import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createCentralSkillExecution } from "../../../../../integration/central-learning/skill-adapter.js";
import { emptyBoardState } from "../../../../control/state.js";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { retainFrozenStage } from "../../../../../integration/central-learning/stage-evidence.js";
import type { CentralPursuitCandidate } from "../../../../control/decision/pursuit-contract.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { createHermesManagedSkillRuntime } from "../host/managed-runtime.js";
import { withSkillCentralFunding } from "../host/funded-provider.js";
import { journalExperienceFixture } from "../host/journal-experience-fixture.js";
import { createSkillReviewProcess } from "../review-process.js";
import { createSkillCoordination } from "./coordination.js";

test("one explicitly authorized Skill grant survives 64 confirmed unsent handoffs while its next native review retains a separate operation cap", async t => {
  const journal = await journalExperienceFixture(t), turn = journal.turn("observed-source");

  await turn.start("Retain the observed manifest check.");
  await turn.item({ kind: "assistant_text", blockId: "observed", text: "Read the manifest and preserve its declared version." });
  await turn.terminal();
  const scope = path.dirname(journal.filename), at = "2026-11-05T20:00:00.000Z", signal = new AbortController().signal;
  const boardRoot = path.join(scope, "learning", "board");
  const written = await withBoardWriter(boardRoot, async store => {
    let state = emptyBoardState(), serial = 0, reviews = 0, sends = 0, oversizedRejected = false, contextReads = 0;
    const preparedContext = { ref: "context:prepared-skill-stage", text: "Prepared purpose: retain the current owner and probe unknown premises." };
    let currentContext = preparedContext;
    const board: Pick<BoardStore, "load" | "apply"> = { async load() {
      const loaded = await store.load();
      if (loaded.ok) state = loaded.state;
      return loaded;
    },
      async apply(command) {
        const next = await store.apply(command);
        if (next.ok) state = next.state;
        return next;
      } };
    const act = async (action: CoordinationAction) => {
      const result = await board.apply({ type: "coordinate_learning", commandId: `skill-envelope:${++serial}`, issuedAt: at, action });
      assert.ok(result.ok, JSON.stringify(result));
      return result.state;
    };
    const coordination = createSkillCoordination({ board, scope, ownerId: "skill-envelope-owner", now: () => at });
    const report = await coordination.report({ sourceRef: "canonical:observed-source", versionId: journal.sessionId, taskId: "observed-source",
      facts: ["Canonical observed manifest procedure; this contract verifies spending boundaries, not learning quality."], evidenceRefs: ["canonical:observed-source"] });

    assert.ok(report.ok);
    await act({ kind: "decide", issueId: report.issue.issueId, expectedRevision: report.issue.revision,
      decision: "focused_learning", reason: "Explicit cumulative and operation budget contract", sourceRefs: ["canonical:observed-source"] });
    await act({ kind: "open_budget", expectedSequence: state.sequence, budget: { schemaVersion: 1, budgetId: "root:skill-envelope", scope,
      unit: "total_model_tokens", limits: { tokens: 100000, calls: 1000, steps: 1000 }, authorizationRef: "contract:explicit-root" } });
    const operation = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 10000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 };

    await act({ kind: "fund", domain: "skill", issueId: report.issue.issueId, expectedRevision: state.learningIssues![0]!.revision,
      grantId: "grant:skill-original-purpose", budgetId: "root:skill-envelope", expectedSequence: state.sequence,
      authorizationRef: "contract:initial-grant", planRef: "contract:original-purpose", allowance: operation });
    // These releases are confirmed unsent boundaries, never paid native reviews.
    // The canonical writer itself prohibits Skill yield once any reservation exists.
    const grant = () => state.centralLearningGrants![0]!, job = () => state.jobs.find(item => item.jobId === grant().jobId)!;

    for (let index = 0; index < 64; index += 1) {
      const claimId = `claim:confirmed-unsent:${index}`;
      await act({ kind: "claim", jobId: job().jobId, expectedAttempt: job().attempt, expectedIssueRevision: state.learningIssues![0]!.revision,
        claimId, ownerId: "contract:unsent-owner", expiresAt: "2026-11-05T20:10:00.000Z" });
      await act({ kind: "finish", jobId: job().jobId, claimId, expectedIssueRevision: state.learningIssues![0]!.revision,
        result: { kind: "yielded", reason: "confirmed_unsent_boundary" } });
    }

    await act({ kind: "rebudget", grantId: grant().grantId, expectedSequence: state.sequence,
      limits: { tokens: 100000, calls: 1000, steps: 1000 }, authorizationRef: "contract:explicit-cumulative-raise", planRef: "contract:next-native-stage" });
    const review = createSkillReviewProcess({
      async begin(source) {
        assert.equal(source.turnId, "observed-source");
        return { status: "ready", reviewId: "native:one-review", prompt: "Observed manifest procedure" };
      },
      async finish() { return { status: "no_learning", candidateId: "native:one-review" }; }, async release() {} });
    const runtime = createHermesManagedSkillRuntime({ scope, coordination, read: source => journal.opportunity(source.turnId), seen: async () => false,
      contextForIssue: async () => {
        contextReads += 1;
        return currentContext;
      },
      review: (source, work) => review(source, async () => {
        const observedContext = source.experience?.centralLearningContext;

        assert.ok(typeof observedContext === "object" && observedContext !== null);
        assert.equal(Reflect.get(observedContext, "reference"), preparedContext.ref);
        assert.equal(Reflect.get(observedContext, "text"), preparedContext.text);
        reviews += 1;
        assert.deepEqual(work.remaining, { tokens: 10000, calls: 2, steps: 2 });
        const transport: ProviderPort = { async *stream() {
          sends += 1;
          yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 90, totalTokens: 100,
            cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        } };
        let requestId = 0;
        const fundedProvider = withSkillCentralFunding(transport, { funding: work.funding, newId: () => `provider:scripted:${++requestId}` });
        const drain = async (content: string) => {
          const request: ProviderRequest = { attemptId: "native-stage-prompt", model: "scripted", tools: [], messages: [{ role: "user", content }] };
          for await (const _event of fundedProvider.stream(request, work.signal)) { /* Consume the actual funding wrapper. */ }
        };

        await assert.rejects(drain("x".repeat(1500)), /skill_learning_prompt_limit/);
        oversizedRejected = true;
        assert.equal(sends, 0);
        assert.equal(grant().reservations.length, 0);
        const view = await work.funding.inspect();
        assert.ok(view.ok);
        assert.equal(Reflect.get(view, "maxPromptChars"), 1000);
        assert.equal(view.grant.allowance.maxPromptChars, 10000);

        for (let index = 0; index < 2; index += 1) {
          await drain("Read the observed manifest procedure.");
        }

        assert.deepEqual(await work.funding.reserve({ reservationId: "provider:outside-operation", maxTokens: 1 }), { ok: false, reason: "learning_grant_exhausted" });

        return { answer: "No further supported proposal", proposals: [], status: "completed", toolFailures: 0 };
      }, work.signal) });
    const adapter = createCentralSkillExecution({ board, boardRoot, scope, runtime });
    const withoutOperation = await adapter.prepare({ issueId: report.issue.issueId, authorizedAllowance: grant().allowance }, signal);

    assert.equal(withoutOperation.status, "unavailable", "legacy callers cannot mistake cumulative authorization for one operation");
    const prepared = await adapter.prepare({ issueId: report.issue.issueId, authorizedAllowance: grant().allowance,
      operationAllowance: { ...operation, maxPromptChars: 1000 } }, signal);

    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    if (prepared.status !== "ready") throw new Error("native_stage_unavailable");

    assert.deepEqual(prepared.sourceContext, preparedContext, "prepare must expose the actual public context captured in its source binding");
    currentContext = { ref: "context:later-skill-purpose", text: "A later consultation changed the purpose after the stage was funded." };
    assert.deepEqual(prepared.offer.reserve, { tokens: 10000, calls: 2, steps: 2 });
    assert.equal(prepared.authorizedAllowance.maxCalls, 1000);
    const beforeInvalidStage = state.sequence;

    assert.deepEqual(await runtime.runManaged({ issueId: report.issue.issueId, grantId: grant().grantId,
      expectedIssueRevision: state.learningIssues![0]!.revision, sourceBindingRef: prepared.source.sourceBindingRef,
      stageResources: { tokens: 10000, calls: 1000, steps: 1000 } }, signal), { ok: false, reason: "hermes_managed_stage_resources" });
    assert.equal(state.sequence, beforeInvalidStage);
    assert.equal(reviews, 0);
    const fundedStage = { issueId: report.issue.issueId, grantId: grant().grantId,
      expectedIssueRevision: state.learningIssues![0]!.revision, stageRef: prepared.stageRef, policyRef: prepared.policyRef,
      sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer, sourceContext: prepared.sourceContext };
    const candidate: CentralPursuitCandidate = { opportunity: { opportunityId: prepared.offer.offerId, scope,
      targetRef: "definition:skill-native-proposal", instanceRef: prepared.stageRef, sourceRef: prepared.source.sourceBindingRef,
      stage: "initial", conditionRef: "condition:skill-observed-source", baselineRef: "baseline:skill-idle", windowRef: "window:skill-review", offer: prepared.offer },
      source: prepared.source, readiness: { kind: "ready", sourceRef: prepared.source.sourceBindingRef, now: Date.parse(at), nextHandoff: null },
      target: { kind: "boundary-independent", sourceRef: "definition:skill-native-proposal" }, fee: { kind: "hard-budget-only", sourceRef: grant().budgetId! },
      purpose: "focused_learning", objective: { instanceId: "objective:skill-review", criterion: "proposal_delivered", definitionRef: "definition:skill-native-proposal",
        familyRef: "family:skill-native-review", familySourceRef: prepared.policyRef } };
    const retained = await retainFrozenStage({ boardRoot, candidate, input: fundedStage });
    assert.equal(retained.status, "retained", JSON.stringify(retained));
    assert.deepEqual(await createCentralSkillExecution({ board, scope, runtime }).dispatch(fundedStage, signal),
      { ok: false, reason: "central_stage_context_archive_unavailable" });
    const beforeSubstitution = state.sequence;
    const substituted = await adapter.dispatch({ ...fundedStage, sourceContext: currentContext }, signal);

    assert.ok(!substituted.ok);
    assert.equal(state.sequence, beforeSubstitution);
    assert.equal(reviews, 0);
    const later = await adapter.prepare({ issueId: report.issue.issueId, authorizedAllowance: grant().allowance,
      operationAllowance: { ...operation, maxPromptChars: 1000 } }, signal);

    assert.equal(later.status, "ready");
    if (later.status !== "ready") throw new Error("later_stage_not_prepared");

    const unretained = await adapter.dispatch({ ...fundedStage, stageRef: later.stageRef, sourceBindingRef: later.source.sourceBindingRef,
      policyRef: later.policyRef, offer: later.offer, sourceContext: currentContext }, signal);

    assert.ok(!unretained.ok, "Recomputed context and source hashes cannot substitute for the original retained authorization");
    assert.equal(state.sequence, beforeSubstitution);
    assert.equal(reviews, 0);
    assert.equal(sends, 0);
    const dispatched = await adapter.dispatch(fundedStage, signal);

    assert.equal(contextReads, 2, "only the two preparations read current context; dispatch and claimed worker consume the archived snapshot");
    assert.equal(oversizedRejected, true, "An operation-sized prompt must reject before provider reservation or send");
    assert.ok(dispatched.ok, JSON.stringify(dispatched));
    assert.equal(dispatched.status, "completed");
    assert.equal(sends, 2);
    assert.equal(reviews, 1);
    assert.equal(job().attempt, 65);
    assert.equal(grant().status, "closed");
    assert.deepEqual(centralLearningSpent(grant()), { tokens: 200, calls: 2, steps: 2 });
    assert.equal(state.centralLearningGrants!.length, 1);
    assert.equal(state.centralLearningBudgets!.length, 1);
    assert.equal(state.rewardV2Facts!.length, 1);
    assert.equal(state.activations.length, 0);

    return { ok: true as const };
  });

  assert.ok(written.ok, JSON.stringify(written));
});
