import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson } from "../../../learning/control/hash.js";
import { resolveCentralAdvisoryPublications } from "../../central-learning/central-advisory-records.js";
import { readCentralAdvisoryAccessSourceInventory } from "../../central-learning/central-advisory-source-access.js";
import type { ContentRecallCandidate } from "./board-contract.js";
import type { ContentAdvisoryRef } from "./advisory-contract.js";

/** An immutable source-owned advisory body. This is neither a ContentRecord
 * process result nor a newly activated domain asset. */
export interface TaskCentralAdvisory extends ContentAdvisoryRef {
  readonly intentId: string;
  readonly purposeHeadRef: string;
  readonly sourceRefs: readonly string[];
  readonly description: string;
  readonly text: string;
}

export interface TaskCentralAdvisoryCandidate {
  readonly description: ContentRecallCandidate;
  readonly advisory: TaskCentralAdvisory;
}

export type CentralAdvisorySourceAccess = (input: { readonly ref: string; readonly version: string;
  readonly sourceRefs: readonly string[]; readonly accessSourceRefs?: readonly string[] }, signal: AbortSignal) => Promise<{
    readonly status: "allowed" | "denied" | "unknown"; readonly sourceRefs: readonly string[] }>;

/** Currentness is the original publisher's projection; access belongs to each
 * actual source owner in this PA context. Neither can substitute for the other. */
export async function nativeCentralAdvisoryCandidates(board: BoardState, input: { readonly scope: string;
  readonly enabled: () => boolean; readonly access?: CentralAdvisorySourceAccess }, signal: AbortSignal): Promise<readonly TaskCentralAdvisoryCandidate[]> {
  if (input.access === undefined || !input.enabled() || signal.aborted) return [];

  const result: TaskCentralAdvisoryCandidate[] = [];
  const views = resolveCentralAdvisoryPublications({ facts: board.rewardV2Facts ?? [], scope: input.scope, boardSequence: board.sequence });

  for (const view of views) {
    if (view.status !== "current" || !input.enabled() || signal.aborted) continue;

    const identity = { ref: view.id, version: view.version };
    const ancestry = readCentralAdvisoryAccessSourceInventory(board, input.scope, view);
    const controls = new Set(ancestry.controlRefs);
    const sourceRefs = [...new Set([...view.sourceRefs, ...ancestry.sourceRefs])].filter(ref => !controls.has(ref));
    // An authenticated public control-only ancestry has no destination data
    // access dependency. It is not an absent source or a quality verdict.
    const permitted = sourceRefs.length === 0 && ancestry.sourceRefs.length > 0 && ancestry.sourceRefs.every(ref => controls.has(ref))
      ? { status: "allowed" as const } : await input.access({ ...identity, sourceRefs }, signal);
    if (permitted.status !== "allowed" || !input.enabled() || signal.aborted) continue;

    const text = canonicalJson({ role: "central_advisory_conditioned_public_knowledge_not_rule_or_verified_benefit",
      ...identity, intentId: view.intentId, purposeHeadRef: view.purposeHeadRef, knowledgeHash: view.knowledgeHash,
      statement: view.statement, conditions: view.conditions, purposeConditions: view.purposeConditions, whenRelevant: view.whenRelevant,
      uncertainty: view.uncertainty, sourceRefs: view.sourceRefs,
      instruction: "Choose whether this knowledge applies to the current task. Report an actual advisory use with central_learning report_advisory_use using this ref and version. Delivery and a use report do not prove benefit." });
    const description = [view.statement, view.conditions, ...view.purposeConditions, view.whenRelevant, view.uncertainty].join("\n");

    result.push({ description: { id: view.id, kind: "central_advisory", subsystem: "central_advisory", active: false,
      sequence: view.sequence, description: description.slice(0, 2000), descriptionOmittedChars: Math.max(0, description.length - 2000),
      sourceRefs: [view.version, view.purposeHeadRef, ...view.sourceRefs] },
    advisory: { ...identity, intentId: view.intentId, purposeHeadRef: view.purposeHeadRef, sourceRefs: view.sourceRefs,
      description, text } });
  }

  return result;
}
