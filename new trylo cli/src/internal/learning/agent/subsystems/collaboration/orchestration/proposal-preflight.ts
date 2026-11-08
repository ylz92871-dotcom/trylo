import { canonicalJson } from "../../../../control/hash.js";
import { EXPERIENCE_CARD_MAX_CHARS, type PublishExperienceInput, type ExperienceResult } from "../experience/contracts.js";
import { isPublishExperienceInput } from "../experience/parse.js";
import { renderExperience } from "../experience/render.js";
import type { CollaborationExperiencePublicationPorts, LearningAction } from "./contracts.js";

type Candidate = Exclude<LearningAction, { readonly kind: "query" }>;

export type ProposalValidationFeedback = {
  readonly reason: string; readonly fields: readonly string[]; readonly instruction: string;
  readonly measurements?: { readonly renderedCardChars: number; readonly maxCardChars: number };
};

export type ProposalPreflightResult = { readonly kind: "ready"; readonly experiences: readonly PublishExperienceInput[] }
  | { readonly kind: "invalid"; readonly reason: string; readonly feedback: ProposalValidationFeedback }
  | { readonly kind: "failed" | "cancelled"; readonly reason: string };

const CONTENT_ERRORS = new Set(["learning_source_unknown", "experience_source_unknown", "experience_owner_unknown", "experience_input_invalid", "experience_sources_invalid"]);

/** Feedback names fields and measurements only. It never echoes a rejected candidate or requests construction/extra quota. */
function invalid(reason: string, fields: readonly string[], input?: PublishExperienceInput): ProposalPreflightResult {
  if (!CONTENT_ERRORS.has(reason)) return { kind: "failed", reason };

  const measured = input !== undefined && typeof input.situation === "string" && Array.isArray(input.responsibilities)
    && input.responsibilities.every(value => typeof value === "string") && typeof input.practice === "string"
    ? renderExperience(input).length : undefined;

  return { kind: "invalid", reason, feedback: { reason, fields,
    instruction: "Revise the indicated candidate fields using supplied references and actual existing owners, or query existing experts. Do not create an owner or request more quota. Keep each complete rendered experience within its card allowance.",
    ...(measured === undefined ? {} : { measurements: { renderedCardChars: measured, maxCardChars: EXPERIENCE_CARD_MAX_CHARS } }) } };
}

/** Validate every candidate before publishing any member of the batch. IO publication still has its own state/commit checks. */
export async function preflightCollaborationProposal(ports: Pick<CollaborationExperiencePublicationPorts, "experienceInput" | "preflightExperience">,
  input: { readonly issueId: string; readonly action: Candidate; readonly knownRefs: ReadonlySet<string>; readonly active: () => Promise<boolean> }): Promise<ProposalPreflightResult> {
  if (input.action.sourceRefs.some(ref => !input.knownRefs.has(ref))) return invalid("learning_source_unknown", ["sourceRefs"]);

  if (input.action.kind === "no_change") return { kind: "ready", experiences: [] };

  const experiences: PublishExperienceInput[] = [];

  for (const [index, draft] of input.action.experiences.entries()) {
    if (!await input.active()) return { kind: "cancelled", reason: "learning_inactive" };

    const field = `experiences[${index}]`;

    if (draft.sourceRefs.some(ref => !input.knownRefs.has(ref))) return invalid("experience_source_unknown", [`${field}.sourceRefs`]);

    const resolved = await ports.experienceInput(input.issueId, draft);
    if (!resolved.ok) return invalid(resolved.reason, [resolved.reason === "experience_owner_unknown" ? `${field}.ownerRef` : field]);

    let checked: ExperienceResult<{ input: PublishExperienceInput }>;

    if (ports.preflightExperience !== undefined) checked = await ports.preflightExperience(resolved.input);
    else {
      // Legacy isolated callers retain shape/card/condition admission, but production must inject the store's provenance check.
      let owned: unknown;
      try { owned = JSON.parse(canonicalJson(resolved.input)); }
      catch { return invalid("experience_input_invalid", [field], resolved.input); }
      checked = isPublishExperienceInput(owned) ? { ok: true as const, input: owned } : { ok: false as const, reason: "experience_input_invalid" };
    }

    if (!checked.ok) return invalid(checked.reason, checked.reason === "experience_sources_invalid"
      ? [`${field}.sourceRefs`, `${field}.parentVersion`] : [field], resolved.input);

    if (checked.input.sourceRefs.some(ref => !input.knownRefs.has(ref))) return invalid("experience_source_unknown", [`${field}.sourceRefs`]);

    experiences.push(checked.input);
  }

  return { kind: "ready", experiences };
}
