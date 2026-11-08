import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralMaterialDeliveryPlan } from "./deliberation-delivery.js";
import { centralMaterialNavigation } from "./deliberation-navigation.js";
import { activePurposeAgendaVersion, createActivePurposeOriginal, parseActivePurposeReadRef, readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { centralBusinessSourceBodyNotice } from "./deliberation-business-sources.js";
import { readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";

const NAVIGATION = "central_source_body_not_delivered";

function originalRef(material: CentralRuntimeMaterial): string {
  const judgment = readCentralJudgmentMaterial(material);
  if (judgment !== undefined) return judgment.originalRef;
  if (!material.ref.startsWith("central-source-navigation:")) return material.ref;
  const body: unknown = JSON.parse(material.text);
  if (typeof body !== "object" || body === null || !("role" in body) || body.role !== NAVIGATION
    || !("originalRef" in body) || typeof body.originalRef !== "string") throw new CentralDeliberationError("central_deliberation_navigation_invalid");
  return body.originalRef;
}

/** This is a delivery view, not a new checkpoint writer. Complete intent
 * meanings and operation identities survive; opaque native frames remain with
 * their original host. Every material body occurs in one input collection. */
export function packCentralDeliberationContext(request: CentralDeliberationRequest,
  quoteFits: (candidate: CentralDeliberationRequest) => boolean): CentralDeliberationRequest {
  const fits = (candidate: CentralDeliberationRequest) => candidate.materials.length <= CENTRAL_RUNTIME_LIMITS.materials
    && candidate.organization.length <= CENTRAL_RUNTIME_LIMITS.materials && quoteFits(candidate);
  const rows = new Map<string, { material: CentralRuntimeMaterial; organization: boolean }>();

  for (const [materials, organization] of [[request.materials, false], [request.state.materials, false], [request.organization, true]] as const) {
    for (const material of materials) {
      const before = rows.get(material.ref);
      if (before !== undefined && canonicalJson(before.material) !== canonicalJson(material)) throw new CentralDeliberationError("central_deliberation_material_identity_conflict");
      rows.set(material.ref, { material, organization: organization || before?.organization === true });
    }
  }

  const inputMaterials = [...rows.values()].map(row => row.material);
  const deliveries = centralMaterialDeliveryPlan(request, inputMaterials);
  const delivery = (material: CentralRuntimeMaterial) => deliveries.get(material.ref)!;
  const ordered = [...rows.values()].sort((a, b) => delivery(a.material).priority - delivery(b.material).priority);

  // An upstream capacity manifest may already have replaced a new PA decision.
  // Its address cannot satisfy reconsideration of that actual governance body.
  if (request.operation.sourceRefs.some(ref => ref.startsWith("central-runtime-constraint:")
    && deliveries.get(ref)?.priority !== 0)) throw new CentralDeliberationError("central_deliberation_context_capacity");

  // Driver preflight and final model preparation share this delivery. Retain
  // its admitted purpose presentation instead of restoring the full agenda
  // and crowding out an already displayed notice on the next pure packing.
  const original = request;
  const activeIds = new Set(request.state.intents.filter(row => row.continuation.kind !== "ended").map(row => row.intentId));
  const nativeResults = new Set<string>(), representedIntents = new Set<string>();

  for (const row of [...request.state.completed].reverse()) {
    if (row.operation.kind !== "dispatch" && row.operation.kind !== "consult") continue;
    if (request.operation.sourceRefs.includes(row.operation.operationId)
      || activeIds.has(row.intentId) && !representedIntents.has(row.intentId)) nativeResults.add(row.operation.operationId);
    representedIntents.add(row.intentId);
  }

  let base: CentralDeliberationRequest = { ...original, materials: [], organization: [], state: { ...request.state, materials: [],
    // The host's notice cursor is not learning knowledge or a body-read proof.
    // Keep it in the canonical checkpoint, rather than retransmit its index.
    consumedSourceRefs: [],
    completed: request.state.completed.map(row => ({ ...row,
      // A native unsent/refused/returned status determines whether any work can
      // arrive. Its latest original receipt must survive purpose continuation;
      // a research request reference alone is not an execution result.
      publicResult: nativeResults.has(row.operation.operationId) ? row.publicResult
        : "Public result body not delivered here; operation, outcome, resultRefs and wait are retained. Read the original result reference when needed." })),
    running: request.state.running.map(row => ({ ...row, frame: { role: "domain_recovery_frame_not_delivered",
      interpretation: "The original host retains the opaque recovery frame and original receipt. This work is still running; this is not a readable source body." } })) } };
  const selected = new Map<string, CentralRuntimeMaterial>();
  const mandatory = new Set<string>();
  const ownPurposeBodies = new Set<string>();
  const view = (): CentralDeliberationRequest => ({ ...base,
    materials: ordered.filter(row => !row.organization && selected.has(row.material.ref)).map(row => selected.get(row.material.ref)!),
    organization: ordered.filter(row => row.organization && selected.has(row.material.ref)).map(row => selected.get(row.material.ref)!) });

  // Current PA governance remains mandatory in either presentation. The agenda
  // is always complete in state; only a proved wire no-fit enables navigation.
  for (const row of ordered) if (delivery(row.material).priority === 0) {
    selected.set(row.material.ref, row.material);
    mandatory.add(row.material.ref);
  }

  // A host-created review of a returned read must see the actual returned
  // originals. Optional directories or owned-purpose copies cannot replace
  // those bodies; the existing purpose-navigation fallback may make room.
  const dependencies = new Set(request.operation.sourceRefs);
  // A newly reasoned recovery carries the same original read dependency even
  // though its operation identity differs from the interrupted review.
  const returnedReadDependency = request.state.completed.some(row => row.intentId === "central:agenda"
    && row.operation.kind === "read" && row.outcome === "returned" && row.resultRefs.length > 0
    && dependencies.has(row.operation.operationId) && row.resultRefs.every(ref => dependencies.has(ref)));
  // The settled read may already be cold while its interrupted review remains
  // pinned. Its complete inherited dependency set is the same review proof.
  const inheritedReadReview = request.state.completed.some(row => row.intentId === "central:agenda"
    && row.operation.operationId.startsWith("central-agenda-read-review:")
    && dependencies.has(row.operation.operationId) && row.operation.sourceRefs.every(ref => dependencies.has(ref)));
  if (request.operation.operationId.startsWith("central-agenda-read-review:") || returnedReadDependency || inheritedReadReview) {
    const originals = ordered.filter(row => dependencies.has(row.material.ref)
      || dependencies.has(readCentralJudgmentMaterial(row.material)?.originalRef ?? ""));
    if (originals.length === 0) throw new CentralDeliberationError("central_deliberation_context_capacity");
    for (const row of originals) {
      selected.set(row.material.ref, row.material);
      mandatory.add(row.material.ref);
    }
  }

  // A fitting old agenda is not yet a useful delivery when its triggering
  // notice cannot fit. Reserve one current, typed notice before optional owned
  // purpose bodies/history; use the existing complete-purpose navigation only
  // when no notice fits beside the full agenda. An opaque address is not a
  // substitute, and an impossible notice still leaves admission to the driver.
  const currentNotices = ordered.filter(row => {
    const plan = delivery(row.material);
    return plan.priority === 1 && (plan.noticeBody === true || (plan.sourceNotices?.length ?? 0) > 0 || (plan.nativeNotices?.length ?? 0) > 0
      || plan.businessSource !== undefined && request.operation.sourceRefs.includes(plan.businessSource.noticeRef));
  });
  const reserveCurrentNotice = () => {
    for (const row of currentNotices) {
      for (const detail of ["semantic", "compact"] as const) {
        selected.set(row.material.ref, delivery(row.material).noticeBody === true ? row.material
          : centralMaterialNavigation(row.material, delivery(row.material), detail));
        if (fits(view())) {
          mandatory.add(row.material.ref);
          return;
        }
      }
      selected.delete(row.material.ref);
    }

    if (request.state.intents.length === 0) return;

    const navigation = { version: "active-purpose-navigation-v2" as const,
      agendaVersion: activePurposeAgendaVersion(request.state.intents), maximumEntries: 1 };

    for (const row of currentNotices) {
      selected.set(row.material.ref, delivery(row.material).noticeBody === true ? row.material
        : centralMaterialNavigation(row.material, delivery(row.material), "compact"));
      if (fits({ ...view(), activePurposeDelivery: navigation })) {
        mandatory.add(row.material.ref);
        return;
      }
      selected.delete(row.material.ref);
    }
  };

  reserveCurrentNotice();

  if (!fits(view())) {
    const agendaVersion = activePurposeAgendaVersion(request.state.intents);

    // A review of an actual original must still carry that original. A cheap
    // navigation call cannot substitute for an object the root cannot afford.
    for (const row of ordered) {
      if (parseActivePurposeReadRef(row.material.ref)?.kind === "body" && request.operation.sourceRefs.includes(row.material.ref)) {
        selected.set(row.material.ref, row.material);
        mandatory.add(row.material.ref);
      }
    }

    const opened = readActivePurposeDelivery({ ...request,
      activePurposeDelivery: { version: "active-purpose-navigation-v2", agendaVersion, maximumEntries: 1 } });

    for (const refs of opened.materialRefsByIntent.values()) {
      if (!refs.some(ref => request.operation.sourceRefs.includes(ref))) continue;
      for (const ref of refs) {
        const row = rows.get(ref);
        if (row !== undefined) {
          selected.set(ref, row.material);
          mandatory.add(ref);
        }
      }
    }

    let admitted = false;

    for (let maximumEntries = Math.min(16, Math.max(1, request.state.intents.length)); maximumEntries >= 1; maximumEntries--) {
      base = { ...base, activePurposeDelivery: { version: "active-purpose-navigation-v2", agendaVersion, maximumEntries } };
      if (fits(view())) {
        admitted = true;
        break;
      }
    }

    if (!admitted) throw new CentralDeliberationError("central_deliberation_context_capacity");

    // The agent already owns this canonical state. If a complete active purpose
    // fits in navigation mode, present it directly instead of buying another
    // model call just to read its own unchanged purpose through an address.
    for (const intent of request.state.intents.filter(row => row.continuation.kind !== "ended")) {
      const body = createActivePurposeOriginal(request.scope, intent);
      if (selected.get(body.ref)?.ref === body.ref) continue;

      const before = base, prior = selected.get(body.ref);

      selected.delete(body.ref);
      base = { ...base, state: { ...base.state, materials: [...base.state.materials, body] } };

      if (fits(view())) {
        ownPurposeBodies.add(body.ref);
        mandatory.add(body.ref);
      }
      else {
        base = before;
        if (prior !== undefined) selected.set(body.ref, prior);
      }
    }
  }

  const offerNavigation = (material: CentralRuntimeMaterial) => {
    if (mandatory.has(material.ref) || selected.get(material.ref)?.ref === material.ref) return;

    const variants = delivery(material).packet === undefined && delivery(material).sourceNotices === undefined
      && delivery(material).nativeNotices === undefined && delivery(material).businessSource === undefined
      ? ["address"] as const : ["semantic", "compact", "address"] as const;

    for (const detail of variants) {
      selected.set(material.ref, centralMaterialNavigation(material, delivery(material), detail));
      if (fits(view())) return;
    }

    selected.delete(material.ref);
  };
  const offerBody = (material: CentralRuntimeMaterial) => {
    if (ownPurposeBodies.has(material.ref)) return;
    const group = [material.ref, ...delivery(material).companionRefs], previous = new Map(group.map(ref => [ref, selected.get(ref)]));
    for (const ref of group) {
      const row = rows.get(ref);
      if (row !== undefined) selected.set(ref, row.material);
    }
    if (fits(view())) return;
    for (const [ref, before] of previous) { if (before === undefined) selected.delete(ref);else selected.set(ref, before); }
  };
  // A directly named correction or priority-one original read body gets its
  // actual schema-inclusive fit attempt before optional source directories.
  // This never displaces mandatory PA/current conditions or promotes a preview.
  const currentSources = new Set(request.operation.sourceRefs);
  const lastReturned = [...request.state.completed].reverse().find(row => row.outcome === "returned");
  const currentReadResults = new Set(lastReturned?.operation.kind === "read" ? lastReturned.resultRefs : []);

  for (const row of ordered) {
    if (delivery(row.material).priority !== 1 || delivery(row.material).navigationOnly
      || isCentralUnreadNavigationMaterial(row.material)) continue;

    const feedback = readOrganizationFeedbackMaterial(row.material, request.scope);
    const currentCorrection = feedback?.value.result.kind === "correction"
      && (currentSources.has(row.material.ref) || currentSources.has(feedback.factId));
    const currentReadBody = row.material.ref.startsWith("central-source-page:")
      && (currentSources.has(row.material.ref) || currentReadResults.has(row.material.ref)
        || row.material.sourceRefs.some(ref => currentSources.has(ref))
        || currentSources.has(centralBusinessSourceBodyNotice(row.material, inputMaterials) ?? ""));
    if (currentCorrection || currentReadBody) offerBody(row.material);
  }

  // Other current semantic alternatives and related history keep their original
  // navigation/body order and remain readable when their bodies cannot fit.
  for (const row of ordered) {
    if (delivery(row.material).priority === 1) offerNavigation(row.material);
  }

  for (const row of ordered) if (delivery(row.material).priority === 1 && !delivery(row.material).navigationOnly) offerBody(row.material);

  for (const row of ordered) {
    if (selected.has(row.material.ref)) continue;
    offerNavigation(row.material);
  }

  for (const row of ordered) {
    if (!delivery(row.material).navigationOnly && delivery(row.material).priority > 1) offerBody(row.material);
  }

  return view();
}

/** Exposure acknowledges source positions, not source-body understanding. */
export function centralDeliveredSourceRefs(request: CentralDeliberationRequest): readonly string[] {
  // The issued attempt names intended sources for recovery fencing. Those
  // names do not acknowledge delivery of the corresponding source notices.
  return [...new Set([...request.materials, ...request.organization].filter(row => !row.ref.startsWith("central-semantic-attempt:"))
    .flatMap(row => [row.ref, ...row.sourceRefs])
    .concat(request.opportunities.map(row => row.sourceRef), request.operation.sourceRefs.filter(ref => ref.startsWith("central-wait-due:"))))];
}

export function hasUnlistedCentralMaterial(materials: readonly CentralRuntimeMaterial[], request: CentralDeliberationRequest): boolean {
  const listed = new Set([...request.materials, ...request.organization].map(originalRef));
  return materials.some(material => !listed.has(originalRef(material)));
}
