import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createSkillCoordination } from "./coordination.js";
import { createSkillPersonalAgentFocus } from "./personal-agent.js";

const scope = "workspace:skill-pa", now = () => "2026-11-04T04:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000,
  maxCalls: 2, maxSteps: 2, maxPromptChars: 1000 };

function fixture() {
  let state = emptyBoardState(), calls = 0;
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const coordination = createSkillCoordination({ board, scope, now, ownerId: "skill-pa" });
  const worker = async () => {
    calls++;
    return { kind: "completed" as const, resultRefs: ["hermes-pending:skills:actual-proposal"] };
  };

  return { state: () => state, calls: () => calls, coordination,
    runtime: { coordination, grantId: "skill-pa:invocation", runFocused: (issueId: string, signal: AbortSignal) => coordination.run({ issueId, signal, worker }),
      dispatchFunded: (signal: AbortSignal) => coordination.dispatchFunded({ signal, worker }) } };
}

async function opportunity(h: ReturnType<typeof fixture>, sourceRef: string) {
  const result = await h.coordination.report({ sourceRef, taskId: sourceRef, facts: ["Real task produced procedural evidence."], evidenceRefs: [] });
  assert.ok(result.ok);
  return { issueId: result.issue.issueId, expectedRevision: result.issue.revision,
    reason: "Review the current task evidence.", sourceRefs: [sourceRef] };
}

test("PA cannot allocate an implicit skill allowance, but can consume an independently funded job", async () => {
  const h = fixture(), input = await opportunity(h, "first"), pa = createSkillPersonalAgentFocus(h.runtime), signal = new AbortController().signal;
  const before = JSON.stringify(h.state());

  assert.deepEqual(await pa.focus(input, signal), { ok: false, reason: "skill_learning_allowance_required" });
  assert.equal(JSON.stringify(h.state()), before);
  assert.equal(h.calls(), 0);
  assert.ok((await h.coordination.focus({ ...input, allowance })).ok);
  const result = await pa.resume(signal);
  assert.ok(result.ok);
  assert.equal(result.status, "completed");
  assert.equal(h.calls(), 1);
  assert.equal(h.state().centralLearningGrants?.length, 1);
  assert.deepEqual(h.state().jobs[0]?.coordination?.resultRefs, ["hermes-pending:skills:actual-proposal"]);
});

test("PA skill focus persists one original allocation across adapter reconstruction and retries", async () => {
  const h = fixture(), input = await opportunity(h, "first"), signal = new AbortController().signal;
  const pa = createSkillPersonalAgentFocus({ ...h.runtime, allowance });
  const completed = await pa.focus(input, signal);
  assert.ok(completed.ok);
  assert.equal(completed.status, "completed");
  const restored = createSkillPersonalAgentFocus({ ...h.runtime, allowance });

  assert.ok((await restored.focus(input, signal)).ok);
  assert.equal(h.calls(), 1);
  const other = await opportunity(h, "second"), before = JSON.stringify(h.state());

  assert.deepEqual(await restored.focus(other, signal), { ok: false, reason: "learning_grant_conflict" });
  assert.equal(JSON.stringify(h.state()), before);
  assert.equal(h.calls(), 1);
  assert.equal(h.state().centralLearningGrants?.length, 1);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await pa.focus(other, controller.signal), { ok: false, reason: "learning_aborted" });
  assert.equal(JSON.stringify(h.state()), before);
});
