import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { RewardV2Draft } from "../../../../reward/v2-facts.js";
import { isRewardV2Draft, isRewardV2Fact } from "../../../../reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { HermesSkillOpportunity } from "../contracts.js";
import { CENTRAL_SKILL_RESEARCH_ALGORITHM, centralSkillResearchFitsNative, centralSkillResearchIssueId,
  centralSkillResearchOpportunity, centralSkillResearchRecordId, isCentralSkillResearchRequest,
  type CentralSkillResearchRequest } from "./central-research-request.js";

type Read = { readonly status: "found"; readonly request: CentralSkillResearchRequest; readonly recordRef: string }
  | { readonly status: "missing" } | { readonly status: "invalid"; readonly reason: string };

/** One request identity has one immutable native source. Later central revisions
 * reach the existing worker through its original contextForIssue boundary. */
export function centralSkillResearchFromBoard(state: BoardState, scope: string, requestRef: string): Read {
  const sources: Extract<Read, { status: "found" }>[] = [];

  for (const fact of state.rewardV2Facts ?? []) {
    if (fact.scope !== scope || fact.algorithmVersion !== CENTRAL_SKILL_RESEARCH_ALGORITHM) continue;

    let body: unknown;

    try { body = JSON.parse(fact.payloadJson); }
    catch { return { status: "invalid", reason: "hermes_research_source_corrupt" }; }

    if (!isRewardV2Fact(fact) || fact.kind !== "projection" || !isCentralSkillResearchRequest(body)
      || body.scope !== scope || fact.id !== centralSkillResearchRecordId(body)
      || canonicalJson(body) !== fact.payloadJson || !centralSkillResearchFitsNative(body)) {
      return { status: "invalid", reason: "hermes_research_source_corrupt" };
    }

    if (body.requestRef === requestRef) sources.push({ status: "found", request: body, recordRef: fact.id });
  }

  return sources.length > 1 ? { status: "invalid", reason: "hermes_research_source_conflict" }
    : sources[0] ?? { status: "missing" };
}

export async function saveCentralSkillResearchRequest(store: Pick<BoardStore, "load" | "apply">,
  request: CentralSkillResearchRequest, issuedAt: string, signal: AbortSignal): Promise<Read> {
  if (signal.aborted) return { status: "invalid", reason: "learning_aborted" };

  if (!isCentralSkillResearchRequest(request)) return { status: "invalid", reason: "hermes_research_request_invalid" };

  if (!centralSkillResearchFitsNative(request)) return { status: "invalid", reason: "hermes_research_material_capacity" };

  const loaded = await store.load();
  if (!loaded.ok) return { status: "invalid", reason: loaded.reason };

  const existing = centralSkillResearchFromBoard(loaded.state, request.scope, request.requestRef);
  if (existing.status !== "missing") return existing.status === "found" && (existing.request.intentRef !== request.intentRef
    || existing.request.workspaceRoot !== request.workspaceRoot)
    ? { status: "invalid", reason: "hermes_research_source_conflict" } : existing;

  const fact: RewardV2Draft = { id: centralSkillResearchRecordId(request), scope: request.scope,
    algorithmVersion: CENTRAL_SKILL_RESEARCH_ALGORITHM, kind: "projection", payloadJson: canonicalJson(request) };
  if (!isRewardV2Draft(fact)) return { status: "invalid", reason: "hermes_research_material_capacity" };

  if (signal.aborted) return { status: "invalid", reason: "learning_aborted" };

  const saved = await store.apply({ type: "record_reward_v2_fact", commandId: `${fact.id}:record`, issuedAt,
    expectedSequence: loaded.state.sequence, fact });

  return saved.ok ? { status: "found", request, recordRef: fact.id } : { status: "invalid", reason: saved.reason };
}

/** The actual managed worker re-reads this source from the original Board. No
 * fallback to an unrelated journal or synthetic business terminal is allowed. */
export async function readCentralSkillResearchOpportunity(options: { readonly board: Pick<BoardStore, "load">;
  readonly scope: string; readonly workspaceRoot: string }, requestRef: string, signal: AbortSignal): Promise<HermesSkillOpportunity | undefined> {
  if (signal.aborted) return undefined;

  const loaded = await options.board.load();
  if (!loaded.ok) throw new Error(loaded.reason);

  const source = centralSkillResearchFromBoard(loaded.state, options.scope, requestRef);
  if (source.status === "invalid") throw new Error(source.reason);

  if (source.status === "missing" || signal.aborted) return undefined;

  const issue = loaded.state.learningIssues?.find(item => item.issueId === centralSkillResearchIssueId(source.request) && item.scope === options.scope);
  const bound = issue?.reports.some(report => "kind" in report.source && report.source.kind === "research_request"
    && report.source.domain === "skill" && report.source.requestRef === requestRef && report.source.intentRef === source.request.intentRef
    && report.evidenceRefs.includes(source.recordRef));
  if (!bound || source.request.workspaceRoot !== options.workspaceRoot) throw new Error("hermes_research_source_conflict");

  return centralSkillResearchOpportunity(source.request);
}

export function centralSkillResearchReport(source: Extract<Read, { status: "found" }>) {
  const request = source.request;
  return { reportId: `skill-research-report:${contentHashOf([request.scope, request.requestRef])}`,
    source: { kind: "research_request" as const, domain: "skill" as const, requestRef: request.requestRef, intentRef: request.intentRef },
    facts: ["Central learning requested native skill research from public, source-qualified materials.",
      "This request is derived from existing observations; it does not create a completed task, adoption, verification or permission."],
    // The full reference set remains in the immutable native source; the Board
    // report is a bounded navigation entry into it, not an evidence replacement.
    evidenceRefs: [...new Set([request.requestRef, request.intentRef, source.recordRef, ...request.sourceRefs])].slice(0, 32) };
}
