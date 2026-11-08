import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CentralResearchReception } from "../../../../../integration/central-learning/contracts.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import { contentHashOf } from "../../../../control/hash.js";
import { methodResearchIssueId, methodResearchRecord, readMethodResearch, type MethodResearchRequest } from "./central-research-records.js";

export interface CentralMethodResearchIntakeOptions {
  readonly boardRoot: string; readonly scope: string; readonly workspaceId: string;
  readonly now: () => number; readonly enabled: () => boolean;
}

/** This creates a source request, not a method version, observation or funding grant. */
export async function acceptCentralMethodResearch(options: CentralMethodResearchIntakeOptions, request: GroundedCentralResearch,
  signal: AbortSignal): Promise<CentralResearchReception> {
  const refs = [...new Set([request.requestRef, request.intent.intentId, ...request.sourceRefs])];
  const waiting = (reason: string): CentralResearchReception => ({ status: "waiting", reason, sourceRefs: refs });

  if (signal.aborted || !options.enabled()) return waiting("method_research_inactive");

  if (request.domain !== "prompt" || refs.length > 32) return waiting("method_research_grounding_invalid");

  const result = await withBoardWriter(options.boardRoot, async store => {
    let loaded = await store.load();
    if (!loaded.ok) return waiting(loaded.reason);

    if (!options.enabled() || signal.aborted) return waiting("method_research_inactive");

    const prior = readMethodResearch(loaded.state, options.scope, request.requestRef);
    const value: MethodResearchRequest = prior?.request ?? { type: "method_research_request", schemaVersion: 1,
      requestRef: request.requestRef, intentRef: request.intent.intentId, intent: request.intent,
      materials: request.materials, sourceRefs: request.sourceRefs };
    const fact = methodResearchRecord(options.scope, value), at = new Date(options.now()).toISOString();

    if (prior === undefined) {
      const recorded = await store.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`,
        issuedAt: at, expectedSequence: loaded.state.sequence, fact });
      if (!recorded.ok) return waiting(recorded.reason);
      loaded = await store.load();
      if (!loaded.ok) return waiting(loaded.reason);
    }

    const issueId = methodResearchIssueId(request.requestRef);
    const existing = loaded.state.learningIssues?.find(row => row.issueId === issueId);
    if (existing !== undefined) return { status: "accepted" as const, issueId, sourceRefs: [...refs, fact.id] };

    const action = { kind: "report" as const, scope: options.scope, issueId,
      problemKey: `method-research:${contentHashOf(request.requestRef)}`, expectedRevision: 0,
      report: { reportId: `method-research-report:${contentHashOf(request.requestRef)}`,
        source: { kind: "research_request" as const, domain: "prompt" as const,
          requestRef: request.requestRef, intentRef: request.intent.intentId },
        facts: ["central_method_research_request_not_observation"], evidenceRefs: refs } };
    const reported = await store.apply({ type: "coordinate_learning", commandId: `method-research:${contentHashOf(action)}`,
      issuedAt: at, action });

    return reported.ok ? { status: "accepted" as const, issueId, sourceRefs: [...refs, fact.id] } : waiting(reported.reason);
  }, { commandGuard: () => options.enabled() && !signal.aborted });

  return "ok" in result ? waiting(result.reason) : result;
}
