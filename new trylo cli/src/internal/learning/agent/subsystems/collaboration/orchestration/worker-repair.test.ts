import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationDecisionModel } from "../runtime/decision-model.js";
import { createCollaborationWorker } from "./worker.js";

const NOW = "2026-11-03T12:00:00.000Z", scope = "workspace:protocol-repair";
const unexpected = (): never => { throw new Error("Protocol repair must not query a library, publish an experience, or invoke the parent provider"); };
const proposal = { kind: "propose", familyId: "handoff-reference", title: "Share an explicit artifact contract", summary: "A reference is needed before dependent work.",
  sourceRefs: ["report:repair"], adjustments: [{ memberId: "worker", kind: "handoff", instruction: "Include the artifact path before handing over dependent work." }], experiences: [] };

async function fixture(maxCalls: number) {
  let state = emptyBoardState();
  const requests: ProviderRequest[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const provider: ProviderPort = { fork: () => ({ async *stream(request) {
    requests.push(request);
    assert.equal(state.assets.length, 0, "an invalid candidate must never be published before its corrected successor");
    const attempt = requests.length;
    const candidate = attempt === 1 ? { ...proposal, summary: "INVALID_OUTPUT_BODY_MUST_NOT_BE_REPEATED" } : { ...proposal, needs: [] };

    yield { type: "text_delta", blockId: "candidate", text: JSON.stringify(candidate) };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 1000, outputTokens: attempt === 1 ? 100 : 120,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: attempt === 1 ? 1100 : 1120 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }), stream: unexpected };
  const worker = createCollaborationWorker({ board, scope, now: () => NOW, model: createCollaborationDecisionModel({ provider, model: "development-only" }),
    resources: { query: unexpected }, context: async () => ({ surface: "code" }), experienceInput: unexpected, publishExperience: unexpected });
  const control = createCollaborationControl({ board, worker, now: () => NOW, ownerId: "repair-owner" });
  const reported = await control.report({ scope, problemKey: "handoff-reference", report: { reportId: "report:repair",
    source: { teamRunId: "team:repair", taskId: "task:repair", memberId: "worker" }, facts: ["The dependent member could not find the original artifact."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision, decision: "focused_learning",
    reason: "The recurring coordination issue merits a reusable improvement.", sourceRefs: ["report:repair"] });
  assert.ok(focused.ok);
  const funded = await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: "grant:original",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000, maxCalls, maxSteps: maxCalls, maxPromptChars: 40000 } });
  assert.ok(funded.ok);

  return { control, requests, state: () => state };
}

test("invalid model protocol repairs only inside the original funded claim, and exhausted allowance never mints a repair budget", async () => {
  const h = await fixture(2), result = await h.control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "completed", "a missing required needs array must receive bounded protocol feedback instead of terminating immediately");
  assert.equal(h.requests.length, 2);
  assert.equal(h.state().assets.length, 1);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(h.state().jobs.length, 1);
  const grant = h.state().centralLearningGrants![0]!;
  assert.equal(grant.grantId, "grant:original");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 2220, calls: 2, steps: 2 });
  assert.equal(new Set(grant.reservations.map(r => r.claimId)).size, 1);
  const feedback = h.requests[1]!.messages.find(m => m.role === "user")!.content;

  assert.match(feedback, /learning_action_invalid/);
  assert.match(feedback, /按原schema重新生成/);
  assert.doesNotMatch(feedback, /INVALID_OUTPUT_BODY_MUST_NOT_BE_REPEATED/);
  const noBudget = await fixture(1), failed = await noBudget.control.dispatch({ scope });
  assert.ok(failed.ok);
  assert.equal(failed.status, "failed");
  assert.equal(noBudget.requests.length, 1);
  assert.equal(noBudget.state().assets.length, 0);
  assert.deepEqual(centralLearningSpent(noBudget.state().centralLearningGrants![0]!), { tokens: 1100, calls: 1, steps: 1 });
  assert.equal(noBudget.state().centralLearningGrants!.length, 1);
  assert.equal(noBudget.state().jobs.length, 1);
  await noBudget.control.dispatch({ scope });
  assert.equal(noBudget.requests.length, 1);
  assert.equal(noBudget.state().centralLearningGrants!.length, 1);
});
