import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence, text } from "../../validation/json-shape.js";
import { sessionContentAddress } from "../learning-content/sources/session-address.js";
import { readCentralReferenceSelectionCapability } from "./change-reference-contract.js";
import { isCentralSingleActionVersion } from "./change-single-action-version.js";
import { projectUserPeerStatusMaterials } from "../user-learning/central-status-navigation.js";
import { centralBusinessSourceDirectory } from "./deliberation-business-sources.js";

export interface CentralAdvisoryTransportControl {
  readonly controlRefs: readonly string[];
  readonly sourceRefs: readonly string[];
  /** Unread addresses are not ancestors of a body which was never delivered. */
  readonly unread: boolean;
}

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Closed native transport envelopes. Ordinary prose/quoted JSON and invented
 * prefixes never qualify. Semantic previews retain real source-owner checks. */
export function readCentralAdvisoryTransportControl(board: BoardState, scope: string,
  material: CentralRuntimeMaterial, originals?: ReadonlyMap<string, CentralRuntimeMaterial>,
  archivedOriginals?: ReadonlyMap<string, CentralRuntimeMaterial>): CentralAdvisoryTransportControl | undefined {
  const result = (controlRefs: readonly string[] = [], sourceRefs: readonly string[] = [], unread = false): CentralAdvisoryTransportControl =>
    ({ controlRefs: [material.ref, ...controlRefs], sourceRefs, unread });
  const legacy = projectUserPeerStatusMaterials([material])[0]!;
  if (legacy !== material) return result(material.sourceRefs, [], true);

  const directory = centralBusinessSourceDirectory(material);
  if (directory !== undefined) return result([directory.noticeRef], [], true);

  if (readCentralReferenceSelectionCapability(material) !== undefined) return result();

  let value: unknown;
  try { value = JSON.parse(material.text); } catch { return undefined; }

  if (!record(value) || material.text !== canonicalJson(value)) return undefined;

  if (material.ref.startsWith("central-runtime-fragment:")
    && fields(value, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
    && typeof value.originalRef === "string" && typeof value.text === "string"
    && sequence(value.start) && sequence(value.end) && sequence(value.totalChars)
    && value.end > value.start && value.end - value.start === value.text.length
    && material.ref === `central-runtime-fragment:${contentHashOf([value.originalRef, value.start, value.text])}`) {
    const parent = originals?.get(value.originalRef) ?? archivedOriginals?.get(value.originalRef);
    if (parent !== undefined && value.totalChars === parent.text.length && value.text === parent.text.slice(value.start, value.end)
      && value.nextRef === (value.end === value.totalChars ? null : `central-runtime-page:${value.end}:${encodeURIComponent(parent.ref)}`)
      && canonicalJson(material.sourceRefs) === canonicalJson([...new Set([parent.ref, ...parent.sourceRefs])])) return result([], material.sourceRefs);
  }

  if (material.ref.startsWith("central-source-navigation:")) {
    const optional = ["businessSource", "businessSourceInterpretation", "sourceNotices", "remainingSelectedNotices", "noticeInterpretation",
      "queryReads", "knowledgeHeads", "remainingKnowledgeHeads", "interpretation", "relatedKnowledgeCount"].filter(k => Object.hasOwn(value, k));
    if (!fields(value, ["role", "originalRef", "readRef", "deliveryPriority", "originalKind", "sourceHash", "totalChars", ...optional])
      || value.role !== "central_source_body_not_delivered" || !identity(value.originalRef) || !identity(value.readRef)
      || value.originalKind !== material.kind || !hash(value.sourceHash) || !sequence(value.totalChars)
      || !sequence(value.deliveryPriority) || value.deliveryPriority > 5
      || material.ref !== `central-source-navigation:${contentHashOf(value)}`) return undefined;

    const controls: string[] = [], sources: string[] = [], notices: string[] = [];

    if (value.businessSource !== undefined) {
      const b = value.businessSource;
      if (!record(b) || !text(b.sessionId, 512) || !text(b.turnId, 512) || !sequence(b.through)
        || typeof b.noticeRef !== "string" || !/^central-business-turn:[a-f0-9]{64}$/.test(b.noticeRef)) return undefined;
      controls.push(b.noticeRef);
      notices.push(b.noticeRef);
      if (b.taskPreview !== undefined) sources.push(sessionContentAddress({ sessionId: b.sessionId, journalSequence: b.through, turnId: b.turnId }));
    }

    if (value.sourceNotices !== undefined) {
      if (!Array.isArray(value.sourceNotices)) return undefined;
      for (const entry of value.sourceNotices) {
        if (!record(entry) || !identity(entry.noticeRef) || !identity(entry.issueId)) return undefined;
        const issue = (board.learningIssues ?? []).find(row => row.scope === scope && row.issueId === entry.issueId);
        if (issue === undefined || entry.problem !== issue.problemKey) return undefined;
        notices.push(entry.noticeRef);
        controls.push(entry.noticeRef);
        sources.push(...issue.reports.flatMap(row => row.evidenceRefs));
      }
    }

    if (value.knowledgeHeads !== undefined) {
      if (!Array.isArray(value.knowledgeHeads)) return undefined;
      for (const entry of value.knowledgeHeads) {
        if (!record(entry) || !identity(entry.factId) || !(board.rewardV2Facts ?? []).some(f => f.scope === scope && f.id === entry.factId)) return undefined;
        sources.push(entry.factId);
      }
    }

    // Source-page navigation also retains the exact public original address.
    const extra = material.sourceRefs.filter(ref => ref !== value.originalRef && !notices.includes(ref));
    if (extra.some(ref => !/^session-(address|content|public-turn):/.test(ref))) return undefined;

    sources.push(...extra);

    return result(controls, sources, true);
  }

  if (material.kind === "source" && material.ref === `central-runtime-catalog:${contentHashOf(material.text)}`
    && fields(value, ["role", "availableIssues", "shownIssues", "nextReadRef", "entries"])
    && value.role === "original_report_catalog_not_read_body" && Array.isArray(value.entries)) {
    const controls: string[] = [];

    for (const entry of value.entries) {
      if (!record(entry) || !identity(entry.issueId) || !identity(entry.readRef)) return undefined;
      const issue = (board.learningIssues ?? []).find(row => row.scope === scope && row.issueId === entry.issueId);
      if (issue === undefined || entry.problem !== issue.problemKey) return undefined;
      controls.push(entry.readRef);
      if (typeof entry.noticeRef === "string") controls.push(entry.noticeRef);
    }

    const expected = value.entries.flatMap(entry => record(entry) && typeof entry.noticeRef === "string" ? [entry.noticeRef] : []);
    if (canonicalJson(material.sourceRefs) !== canonicalJson(expected)) return undefined;

    return result(controls, [], true);
  }

  if (material.kind === "source" && material.ref === `central-runtime-constraint:${contentHashOf(material.text)}`) {
    if (fields(value, ["role", "scope", "providerId", "model", "providerConnectionRef",
      ...(Object.hasOwn(value, "decisionFormat") ? ["decisionFormat"] : []), ...(Object.hasOwn(value, "decisionVersion") ? ["decisionVersion"] : [])])
      && value.role === "actual_provider_connection_not_business_evidence" && value.scope === scope
      && [value.providerId, value.model, value.providerConnectionRef].every(v => text(v, 512))
      && (!Object.hasOwn(value, "decisionFormat") || value.decisionFormat === "action_tool" || value.decisionFormat === "action_json")
      && (!Object.hasOwn(value, "decisionVersion") || isCentralSingleActionVersion(value.decisionVersion))
      && material.sourceRefs.length === 0) return result();
    if (fields(value, ["role", "issueId", "decision"]) && value.role === "PA_current_constraint_not_business_evidence"
      && (board.learningIssues ?? []).some(row => row.scope === scope && row.issueId === value.issueId)
      && record(value.decision) && Array.isArray(value.decision.sourceRefs) && value.decision.sourceRefs.every(identity)
      && material.sourceRefs.length === 0) return result([], value.decision.sourceRefs);
  }

  if (material.kind === "organization" && fields(value, ["role", "units", "instruction"])
    && value.role === "shared_original_cost_units_not_additive_decision_spend" && Array.isArray(value.units)
    && material.ref === `organization-shared-cost:${contentHashOf(value.units)}` && material.sourceRefs.length === 0) {
    const sources: string[] = [];

    for (const unit of value.units) {
      if (!fields(unit, ["unitRef", "decisionRefs", "allocatedCostForEachDecision"]) || !identity(unit.unitRef)
        || !Array.isArray(unit.decisionRefs) || !unit.decisionRefs.every(identity) || unit.allocatedCostForEachDecision !== "unknown") return undefined;
      sources.push(unit.unitRef, ...unit.decisionRefs);
    }

    return result([], sources);
  }

  return undefined;
}
