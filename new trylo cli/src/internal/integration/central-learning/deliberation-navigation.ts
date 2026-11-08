import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralMaterialPageRef } from "./deliberation-material.js";
import { centralMaterialObject, type CentralMaterialDelivery } from "./deliberation-delivery.js";

/** Navigation retains a readable original, and never becomes a delivered packet
 * or a head-body citation merely by showing a short semantic description. */
export function centralMaterialNavigation(material: CentralRuntimeMaterial, delivery: CentralMaterialDelivery,
  detail: "semantic" | "compact" | "address" = "semantic"): CentralRuntimeMaterial {
  if (material.ref.startsWith("central-source-navigation:")) return material;

  const object = centralMaterialObject(material), noticeRefs: string[] = [];
  let readRef = material.ref;

  if (object?.role === "actual_source_fragment_not_full_source" && typeof object.ref === "string" && typeof object.start === "number"
    && typeof object.originalRef === "string" && material.sourceRefs.includes(object.originalRef)) {
    readRef = centralMaterialPageRef(object.ref, object.start);
    noticeRefs.push(object.originalRef);
  }

  const entries = delivery.packet?.entries;
  const sourceNotices = detail === "address" ? [] : delivery.sourceNotices?.slice(0, detail === "compact" ? 1 : 4) ?? [];
  const nativeChangeNotices = detail === "address" ? []
    : detail === "compact" ? delivery.nativeNotices?.slice(0, 1) ?? [] : delivery.nativeNotices ?? [];
  const businessSource = detail === "address" ? undefined : delivery.businessSource;
  if (businessSource !== undefined) noticeRefs.push(businessSource.noticeRef);

  noticeRefs.push(...sourceNotices.map(entry => entry.noticeRef));
  noticeRefs.push(...nativeChangeNotices.map(entry => entry.noticeRef));
  const value = { role: "central_source_body_not_delivered", originalRef: material.ref, readRef, deliveryPriority: delivery.priority,
    originalKind: material.kind, sourceHash: contentHashOf(material.text), totalChars: material.text.length,
    ...(businessSource === undefined ? {} : { businessSource: detail === "compact" ? {
      sessionId: businessSource.sessionId, turnId: businessSource.turnId, through: businessSource.through,
      noticeRef: businessSource.noticeRef, shownEntries: businessSource.shownEntries, lastShownRole: businessSource.lastShownRole,
      ...(businessSource.taskPreview === undefined ? {} : { taskPreview: businessSource.taskPreview }),
    } : businessSource, businessSourceInterpretation: "Original host directory and bounded catalog preview only, not a read-body citation. Source bodies remain unread; read this directory before selecting original pages. A terminal entry records an execution boundary, not task quality." }),
    ...(sourceNotices.length === 0 ? {} : { sourceNotices,
      remainingSelectedNotices: delivery.sourceNotices!.length - sourceNotices.length,
      noticeInterpretation: "Only these selected source notices and catalog context were delivered. Their original report bodies remain unread; follow each readRef before quoting or grounding." }),
    ...(nativeChangeNotices.length === 0 ? {} : { nativeChangeReads: nativeChangeNotices,
      remainingSelectedNativeNotices: delivery.nativeNotices!.length - nativeChangeNotices.length,
      nativeNoticeInterpretation: "Only these original change notices were delivered. Native feedback bodies remain unread; follow each readRef before interpreting adoption, quality or benefit." }),
    ...(detail !== "address" && entries !== undefined ? {
      queryReads: delivery.companionRefs.map(readRef => ({ readRef })),
      knowledgeHeads: entries.slice(0, detail === "compact" ? 1 : 2).map(entry => ({ knowledgeId: entry.knowledge.knowledgeId, factId: entry.factId,
        state: entry.knowledge.state, ...(detail === "compact" ? {} : { statementPreview: entry.knowledge.statement.slice(0, 160) }) })),
      remainingKnowledgeHeads: Math.max(0, entries.length - (detail === "compact" ? 1 : 2)),
      interpretation: "Related stored organizing hypotheses exist. Only this index was delivered; read the original packet and its query before claiming use or revision. A match does not prove applicability.",
    } : entries === undefined ? {} : { relatedKnowledgeCount: entries.length,
      interpretation: "Related hypotheses exist; this address does not deliver their bodies or support evidence." }) };

  return { ref: `central-source-navigation:${contentHashOf(value)}`, kind: material.kind,
    text: canonicalJson(value), sourceRefs: [material.ref, ...noticeRefs] };
}
