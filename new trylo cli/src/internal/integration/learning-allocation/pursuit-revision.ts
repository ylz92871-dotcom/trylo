import { fields, identity } from "../../validation/json-shape.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralPursuitObservation } from "../../learning/control/decision/pursuit-contract.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "./pursuit-observations.js";

/** The domain reviews the frozen original stage, not today's expanded request.
 * A raw negative report or context-delivery receipt cannot supply this verdict. */
export type CentralPursuitQualificationReview = {
  readonly kind: "original_criterion_review";
  readonly definitionRef: string;
  readonly frameRef: string;
  readonly origin: "domain_receipt" | "external_checker" | "user_original_criterion";
  readonly outcome: CentralPursuitObservation["outcome"];
  readonly sourceRef: string;
  readonly evidenceRefs: readonly string[];
} | { readonly kind: "new_requirements" | "unresolved"; readonly sourceRef: string; readonly evidenceRefs: readonly string[] };

export type CentralPursuitQualificationRevision = { readonly status: "ready"; readonly draft: RewardV2Draft;
  readonly previousHeadFactId: string; readonly previous: CentralPursuitObservation }
  | { readonly status: "no_revision"; readonly reason: string }
  | { readonly status: "stale" | "invalid"; readonly reason: string };

function validReview(value: unknown): value is CentralPursuitQualificationReview {
  if (!(fields(value, ["kind", "sourceRef", "evidenceRefs"])
    || fields(value, ["kind", "definitionRef", "frameRef", "origin", "outcome", "sourceRef", "evidenceRefs"]))
    || !identity(value.sourceRef) || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1
    || value.evidenceRefs.length > 32 || !value.evidenceRefs.every(identity)
    || new Set(value.evidenceRefs).size !== value.evidenceRefs.length) return false;

  if (value.kind === "new_requirements" || value.kind === "unresolved") return Object.keys(value).length === 3;

  return value.kind === "original_criterion_review" && identity(value.definitionRef) && identity(value.frameRef)
    && (value.origin === "domain_receipt" || value.origin === "external_checker" || value.origin === "user_original_criterion")
    && (value.outcome === "qualified" || value.outcome === "closed_no_result" || value.outcome === "pending");
}

/** Produces only an original-Board correction draft. The host still appends with
 * its current Board CAS. Identity/criterion/resource treatment are copied from
 * the effective original head, never guessed from the current source settings. */
export function buildCentralPursuitQualificationRevisionDraft(input: { readonly board: BoardState; readonly scope: string;
  readonly unitId: string; readonly expectedHeadFactId: string; readonly review: CentralPursuitQualificationReview }): CentralPursuitQualificationRevision {
  if (!fields(input, ["board", "scope", "unitId", "expectedHeadFactId", "review"])
    || ![input.scope, input.unitId, input.expectedHeadFactId].every(identity) || !validReview(input.review)) {
    return { status: "invalid", reason: "pursuit_qualification_review_input" };
  }

  const current = readCentralPursuitObservations(input.board, input.scope);
  if (current.status !== "ready") return current;

  const head = current.heads.find(row => row.unitId === input.unitId);
  const original = current.observations.find(row => row.unitId === input.unitId);
  if (head === undefined || original === undefined) return { status: "invalid", reason: "pursuit_qualification_unit_missing" };

  if (head.factId !== input.expectedHeadFactId) return { status: "stale", reason: "pursuit_qualification_head_changed" };

  if (input.review.kind !== "original_criterion_review") return { status: "no_revision", reason: input.review.kind };

  if (input.review.definitionRef !== original.objective.definitionRef || input.review.frameRef !== original.stageRef) {
    return { status: "invalid", reason: "pursuit_qualification_frozen_frame_mismatch" };
  }

  if (input.review.outcome === original.outcome && input.review.sourceRef === original.sourceRef) {
    return { status: "no_revision", reason: "pursuit_qualification_unchanged" };
  }

  const { sequence: _sequence, ...frozen } = original;
  const draft = createCentralPursuitObservationDraft({ ...frozen, outcome: input.review.outcome,
    sourceRef: input.review.sourceRef, revisionRef: `pursuit-criterion-review:${contentHashOf({
      unitId: input.unitId, previousHead: head.factId, review: input.review })}`, supersedes: head.factId });

  return draft.status === "ready" ? { status: "ready", draft: draft.value, previousHeadFactId: head.factId, previous: original } : draft;
}
