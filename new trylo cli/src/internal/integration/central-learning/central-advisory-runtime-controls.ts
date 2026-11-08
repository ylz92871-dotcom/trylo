import type { BoardState } from "../../learning/control/state.js";
import type { CentralCompletedOperation, CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePrefix } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { sequence } from "../../validation/json-shape.js";
import { semanticAttemptMaterial } from "./runtime-recovery.js";
import { centralBudgetChangeSourceRef, latestCentralBudgetChangeSource } from "./runtime-budget-source.js";
import { readCentralReferenceSelectionCapability, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF } from "./change-reference-contract.js";
import { assertCentralActionCorrectionDelivery } from "./runtime-action-correction.js";
import { readCentralPurposeMemory, isOriginalCentralPurposeNavigation } from "./runtime-purpose-memory.js";
import { readCentralMethodResearchMaterial } from "./research-intake-method.js";
import { centralResearchEpisodeMetadataMaterial, readCentralResearchProgramReportMetadata } from "./research-intake-episode-metadata.js";
import { isUserPeerStatusNavigation, projectUserPeerStatusMaterials } from "../user-learning/central-status-navigation.js";
import { sessionContentAddress } from "../learning-content/sources/session-address.js";
import { sessionSourceAddressesForIssue } from "../learning-content/sources/session-issue-address.js";

const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
const object = (m: CentralRuntimeMaterial): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(m.text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  }
  catch { return undefined; } // Ordinary prose is not a native control envelope.
};

/** Exact native identities, not a namespace allowlist. Classifying bookkeeping
 * never removes its separately retained business-source edges or grants access. */
export function createCentralAdvisoryRuntimeControls(board: BoardState, scope: string,
  prefix: ReturnType<typeof readCentralRuntimePrefix>) {
  const roots = (board.centralLearningBudgets ?? []).filter(row => row.scope === scope);
  const refs = new Set<string>(), originals = new Map<string, CentralRuntimeMaterial>();
  const materialRefs = new Set<string>();
  const edges = new Map<string, readonly string[]>();
  const completions = new Map<string, CentralCompletedOperation>();
  const attempts = new Set<string>(), budgetMaterials = new Set<string>();

  for (const root of roots) {
    refs.add(root.budgetId);

    for (const row of root.accounting ?? []) {
      refs.add(row.reservationId);
      refs.add(`original-root-cost:${contentHashOf([root.budgetId, row.reservationId])}`);
    }

    for (const change of root.limitChanges ?? []) {
      refs.add(centralBudgetChangeSourceRef(root.budgetId, change.changeId));
      const m = latestCentralBudgetChangeSource({ ...board, centralLearningBudgets: [{ ...root, limitChanges: [change] }] }, scope)?.material;
      if (m !== undefined) budgetMaterials.add(canonicalJson(m));
    }
  }

  for (const row of prefix) {
    const state = row.state;
    for (const ref of state.consumedSourceRefs) if (/^(central-business-turn|central-runtime-issue-notice):[a-f0-9]{64}$/.test(ref)) refs.add(ref);

    for (const intent of state.intents) if (intent.continuation.kind === "ended") {
      const ref = `central-runtime-purpose-record:${contentHashOf([intent.intentId, row.factRef])}`;
      refs.add(ref);
      edges.set(ref, [...new Set([intent.intentId, row.factRef, ...intent.sourceRefs,
        ...intent.knowledge.flatMap(k => k.sourceRefs), ...(intent.derivation?.parentRefs ?? []),
        ...(intent.derivation?.citations.map(c => c.evidenceRef) ?? [])])]);
    }

    for (const done of state.completed) {
      completions.set(done.operation.operationId, done);
      for (const ref of done.operation.sourceRefs) if (/^(central-business-turn|central-runtime-issue-notice):[a-f0-9]{64}$/.test(ref)) refs.add(ref);
      const ref = `central-operation-result:${contentHashOf(done)}`;
      const m = state.materials.find(m => m.ref === ref);
      if (m?.kind === "work_result" && m.text === done.publicResult && same(m.sourceRefs, done.resultRefs)) {
        refs.add(ref);
        materialRefs.add(ref);
      }
    }

    for (const m of state.materials) {
      originals.set(m.ref, m);
      if (!m.ref.startsWith("central-semantic-attempt:")) continue;
      const v = object(m), done = state.completed.find(c => c.operation.operationId === v?.operationId && c.operation.kind === "think");
      if (done !== undefined && sequence(v?.issuedAt) && sequence(v?.recoveryAt) && v.recoveryAt >= v.issuedAt
        && same(m, semanticAttemptMaterial(state, done.operation, v.issuedAt, v.recoveryAt - v.issuedAt))) attempts.add(m.ref);
    }
  }

  for (const issue of board.learningIssues ?? []) {
    if (issue.scope !== scope) continue;
    for (const report of issue.reports) {
      const source = report.source;
      if ("subsystem" in source && source.subsystem === "skill") {
        const alias = `skill-task:${contentHashOf([source.versionId, source.taskId])}`;
        const address = sessionContentAddress({ sessionId: source.versionId, turnId: source.taskId });
        if (report.evidenceRefs.includes(alias) && sessionSourceAddressesForIssue(issue, board).includes(address)) {
          refs.add(alias);
          edges.set(alias, [address]);
        }
      }

      const metadata = readCentralResearchProgramReportMetadata(report);
      if (metadata === undefined || metadata.scope !== scope || report.reportId !== `central-research-program-report:${contentHashOf([scope, issue.issueId, metadata.requestRef, metadata.programRef])}`) continue;

      for (const ref of [metadata.requestRef, metadata.baseRequestRef, metadata.programRef,
        centralResearchEpisodeMetadataMaterial(metadata).ref]) refs.add(ref);
    }
  }

  for (const m of originals.values()) {
    const projected = projectUserPeerStatusMaterials([m])[0]!;
    if (projected === m && !isUserPeerStatusNavigation(m)) continue;
    refs.add(m.ref);
    materialRefs.add(m.ref);
    for (const ref of m.sourceRefs) refs.add(ref);
  }

  const cached = new Map<string, boolean>();

  function material(m: CentralRuntimeMaterial, request: CentralDeliberationRequest,
    materials: ReadonlyMap<string, CentralRuntimeMaterial>): boolean {
    const key = `${request.boardSequence}:${m.ref}`, previous = cached.get(key);
    if (previous !== undefined) return previous;

    const v = object(m), done = typeof v?.operationId === "string" ? completions.get(v.operationId) : undefined;
    let valid = materialRefs.has(m.ref) && same(originals.get(m.ref), m) || attempts.has(m.ref) && same(originals.get(m.ref), m)
      || budgetMaterials.has(canonicalJson(m)) || readCentralReferenceSelectionCapability(m) !== undefined;
    if (!valid && m.ref.startsWith("central-semantic-recovery-blocked:") && v !== undefined && done !== undefined) {
      valid = m.kind === "feedback" && m.ref === `central-semantic-recovery-blocked:${contentHashOf(done.operation.operationId)}`
        && same(m.sourceRefs, [done.operation.operationId]) && same(originals.get(m.ref), m)
        && typeof v.reason === "string" && /^central_[a-z0-9_]+(?:;[a-z_]+=[a-z0-9_]+)*$/.test(v.reason)
        && typeof v.configurationRef === "string" && typeof v.interpretation === "string";
    }

    if (!valid && m.ref.startsWith("central-resource-change:") && v !== undefined) {
      valid = m.kind === "source" && m.ref === `central-resource-change:${contentHashOf(v)}` && m.text === canonicalJson(v)
        && roots.some(root => root.budgetId === v.budgetId) && typeof v.priorWaitRef === "string"
        && originals.has(v.priorWaitRef) && same(originals.get(m.ref), m);
    }

    if (!valid && m.ref.startsWith("central-action-correction-feedback:") && v !== undefined) {
      const operation = [...completions.values()].find(c => c.operation.kind === "think" && c.operation.sourceRefs[2] === m.ref)?.operation;
      if (operation !== undefined && typeof v.budgetId === "string" && roots.some(r => r.budgetId === v.budgetId)) {
        try {
          valid = assertCentralActionCorrectionDelivery({ ...request, budgetId: v.budgetId, operation,
            materials: [...materials.values()], organization: [], state: { ...request.state, materials: [] } },
          CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF) !== undefined;
        } catch { valid = false; } // Only the original closed correction contract qualifies.
      }
    }

    if (!valid && m.ref.startsWith("central-runtime-purpose-record:")) {
      valid = same(readCentralPurposeMemory({ facts: (board.rewardV2Facts ?? []).filter(f => f.sequence <= request.boardSequence), scope, boardSequence: request.boardSequence }, m.ref), m);
    }

    if (!valid && m.ref.startsWith("central-runtime-purpose-navigation:")) {
      valid = isOriginalCentralPurposeNavigation({ facts: (board.rewardV2Facts ?? []).filter(f => f.sequence <= request.boardSequence), scope, boardSequence: request.boardSequence }, m);
    }

    if (!valid && m.ref.startsWith("method-research-record:")) {
      valid = same(readCentralMethodResearchMaterial({ ...board, sequence: request.boardSequence,
        rewardV2Facts: (board.rewardV2Facts ?? []).filter(f => f.sequence <= request.boardSequence) }, scope, m.ref), m);
    }

    cached.set(key, valid);
    return valid;
  }

  return { refs, edges, originals, material };
}
