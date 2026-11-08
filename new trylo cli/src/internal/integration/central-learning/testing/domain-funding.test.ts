import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../ports/provider.js";
import { createBoardReader, withBoardWriter } from "../../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { createLearningAllocationApplication } from "../../learning-allocation/application.js";
import type { CentralFundedStage, CentralStagePreparation } from "../contracts.js";

export const DOMAIN_TEST_SCOPE = "D:/central-domain-contract-workspace";
export const DOMAIN_TEST_NOW = "2026-11-04T13:00:00.000Z";
export const domainTestSignal = () => new AbortController().signal;

export async function withDomainBoard(run: (fx: Awaited<ReturnType<typeof domainBoard>>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "central-domain-contract-"));
  try { await run(await domainBoard(root)); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("central-domain-contract-"));
    await rm(root, { recursive: true, force: true });
  }
}

async function domainBoard(boardRoot: string) {
  let id = 0;
  const load = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `domain-test:${++id}`,
      issuedAt: DOMAIN_TEST_NOW, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const app = createLearningAllocationApplication({ boardRoot, now: () => DOMAIN_TEST_NOW, enabled: () => true });

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1,
    budgetId: "budget:domain-contract", scope: DOMAIN_TEST_SCOPE, unit: "total_model_tokens",
    limits: { tokens: 100000, calls: 16, steps: 16 }, authorizationRef: "test-only:explicit-envelope" } });
  const fund = async (prepared: CentralStagePreparation): Promise<CentralFundedStage> => {
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") throw new Error("Expected a ready original-domain stage");

    const state = await load(), budget = centralBudgetProjection(state, "budget:domain-contract")!;
    const issue = state.learningIssues!.find(item => item.issueId === prepared.source.issueId)!;
    const result = await app.commit({ kind: "portfolio", authorizationRef: "test-only:stage-funding",
      proposalJson: JSON.stringify({ schemaVersion: 1, basis: { scope: DOMAIN_TEST_SCOPE, boardSequence: state.sequence,
        budgetId: budget.budget.budgetId, utilityUnit: "test-only-proposal-delivery", valuationRef: "test-only:fixed-accounting-selection" },
        unit: "total_model_tokens", domainRelation: "separable", budget: budget.available,
        groups: [{ owner: prepared.offer.owner, tiers: [{ quota: 1, netValue: 1, offer: prepared.offer }] }] }),
      bindingsJson: JSON.stringify([{ offerId: prepared.offer.offerId, offerHash: contentHashOf(prepared.offer), policyRef: prepared.policyRef,
        sourceBindingRef: prepared.source.sourceBindingRef, authorizedAllowance: prepared.authorizedAllowance,
        issueId: issue.issueId, expectedIssueRevision: issue.revision, grantId: prepared.source.grantId,
        mode: "fund", chargedAtBasis: { tokens: 0, calls: 0, steps: 0 } }]) });

    assert.equal(result.status, "committed", JSON.stringify(result));
    const after = await load();

    return { issueId: issue.issueId, grantId: prepared.source.grantId,
      expectedIssueRevision: after.learningIssues!.find(item => item.issueId === issue.issueId)!.revision,
      stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  };

  return { boardRoot, load, act, fund, app };
}

/** Scripted transport only. Real domain prompts, parsers, claims, workers, publication and accounting execute unchanged. */
export function domainProvider(output: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>) {
  const requests: ProviderRequest[] = [];
  const stream = async function* (request: ProviderRequest, signal: AbortSignal) {
    requests.push(request);
    yield* output(request, signal);
  };
  const provider: ProviderPort = { stream, fork: () => ({ stream }) };
  return { provider, requests };
}

export async function* successfulDomainResponse(value: unknown): AsyncIterable<ProviderEvent> {
  yield { type: "text_delta", blockId: "domain-output", text: JSON.stringify(value) };
  yield { type: "usage", usage: { mode: "snapshot", inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
}
