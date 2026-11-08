import assert from "node:assert/strict";
import test from "node:test";
import type { UserPeerProgress } from "../../learning/domains/user/learning-cycle-contract.js";
import type { CentralRuntimeWork } from "../../learning/central/runtime/contracts.js";
import { createUserPeerRuntimeAdapter } from "./central-runtime-adapter.js";
import type { UserLearningPeer } from "./peer.js";

const work: CentralRuntimeWork = {
  intentId: "intent:user", workRef: "work:user", operation: { kind: "dispatch", operationId: "operation:user",
    purpose: "compare authentic user evidence", expectedChange: "understand applicability", sourceRefs: ["source:user"],
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 30000, maxCalls: 2, maxSteps: 2, maxPromptChars: 60000 } },
  frame: { kind: "user_learning", ledgerRef: "ledger:user", questionRef: "question:user", sourcePrefixRef: "source:user",
    purpose: "compare authentic user evidence", operationRef: "work:user", maxTokensPerCall: 30000,
    maxTotalTokens: 30000, maxCalls: 2, maxPromptChars: 60000 },
};
const progress: UserPeerProgress = { owner: "user_learning", questionRef: "question:user", sourcePrefixRef: "source:user",
  state: "progress", reason: "user_learning_allowance_boundary", versionRefs: ["version:user"],
  progressRef: "progress:user", waitFor: "budget" };

/** Only typed peer results vary. The adapter receives no model/provider and the
 * publicResult JSON is deliberately never parsed by these contract assertions. */
function adapter(result: UserPeerProgress) {
  const peer: UserLearningPeer = {
    inspect: () => ({ ok: false, reason: "unused_inspect" }),
    advance: async () => result,
    funding: async () => ({ ok: false, reason: "unused_funding" }),
    acceptResearch: () => ({ status: "unavailable", reason: "unused_research" }),
    operationStatus: async () => "stale",
    readClarification: () => undefined,
    recover: () => result,
    recoverBoundary: async () => undefined,
    recoverLocalTimeout: async () => undefined,
  };
  return createUserPeerRuntimeAdapter(peer).execution;
}

test("typed budget progress becomes an explicit resources wait at the execute boundary", async () => {
  const result = await adapter(progress).execute(work, new AbortController().signal);
  assert.equal(result.outcome, "returned");
  assert.equal(result.wait?.kind, "resources");
});

test("typed user clarification waits for facts even when its prose mentions budget", async () => {
  const result = await adapter({ ...progress, state: "waiting", reason: "clarify budget preference with the user",
    waitFor: "user_clarification", clarificationRef: "clarification:user" }).execute(work, new AbortController().signal);
  assert.equal(result.wait?.kind, "facts");
});

test("an unknown outcome and a recovery dependency cannot be reclassified as exhausted resources", async () => {
  const unknown = Object.assign({}, progress, { outcome: "unknown" as const });
  const result = await adapter(unknown).execute(work, new AbortController().signal);

  assert.equal(result.outcome, "unknown");
  assert.notEqual(result.wait?.kind, "resources");
  const recovering = await adapter({ ...progress, state: "waiting", reason: "user_learning_allowance_boundary",
    waitFor: "recovery" }).execute(work, new AbortController().signal);

  assert.notEqual(recovering.wait?.kind, "resources");
});

test("recovering a committed typed budget progress preserves its resources wait", async () => {
  const result = await adapter(progress).recover(work, new AbortController().signal);
  assert.ok(result !== null && !("kind" in result));
  assert.equal(result.outcome, "returned");
  assert.equal(result.wait?.kind, "resources");
});
