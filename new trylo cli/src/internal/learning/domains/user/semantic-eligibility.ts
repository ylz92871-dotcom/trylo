import type { EligibilityDecision, UserEvidence } from "./contracts.js";
import { routeForClass } from "./contracts.js";
import { classifyEligibility } from "./eligibility.js";
import { detectSpeechAct, residualPreference } from "./speech-act.js";
import type { UserSemanticDraft } from "./semantic-draft.js";
import { shortId } from "../shared/hash.js";

const AUTHORITY = /(?:跳过|绕过|禁用|关闭|不要|不用|无需).{0,6}(?:审批|权限检查)|(?:skip|bypass|disable).{0,8}(?:approval|permission)|(?:allowNetwork|skipApproval)\s*[:=]\s*true/iu;
const QUALITY = /(?:不许|不要|禁止|避免).{0,6}(?:编造|造假|胡说|瞎编|丢数据)|真实性|必须正确|不能出错/iu;

export function safeUserPolicyInstruction(text: string): boolean {
  return !AUTHORITY.test(text) && !QUALITY.test(text);
}

/** The semantic model may interpret ambiguity, but cannot overrule these non-preference classes. */
export function classifySemanticUserEligibility(evidence: UserEvidence,
  proposed: UserSemanticDraft["eligibility"][number] | undefined, now: number): EligibilityDecision {
  const original = classifyEligibility({ evidence, speechAct: detectSpeechAct(evidence.rawText), residualText: residualPreference(evidence.rawText), now });
  const prohibited = !safeUserPolicyInstruction(evidence.rawText) || proposed === undefined
    || original.classification === "session_instruction";
  const classification = AUTHORITY.test(evidence.rawText) ? "authorization_or_permission"
    : QUALITY.test(evidence.rawText) ? "general_quality_defect"
      : prohibited ? original.classification : proposed!.classification;

  return { ...original, id: shortId("elig", [evidence.id, classification]), classification, route: routeForClass(classification),
    rationale: prohibited ? original.rationale : proposed?.rationale ?? original.rationale };
}

