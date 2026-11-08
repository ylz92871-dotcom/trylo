import type { Transcript } from "../../../../../protocol/transcript.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { SkillTaskReport } from "./contracts.js";
import type { SkillUserAttribution } from "../contracts.js";

/** Factual sensors give the centre a source identity, never a lesson to learn. */
export function skillTaskReport(input: {
  readonly sessionId: string; readonly turnId: string; readonly transcript: Transcript;
  /** Observed successful instruction loads from earlier turns in this same session. */
  readonly historyLoadedSkills?: readonly string[];
  /** Host-observed prior explicit native provision, separately from model-facing tool reads. */
  readonly historyProvidedSkills?: readonly string[];
  /** Canonical host marker, not an interpretation of transport text or labels. */
  readonly userAttribution?: SkillUserAttribution;
}): SkillTaskReport | undefined {
  const tools = input.transcript.filter(item => item.kind === "tool_result");
  const users = input.transcript.filter(item => item.kind === "user");
  const earlierLoads = input.historyLoadedSkills?.length ?? 0;
  const earlierProvided = input.historyProvidedSkills?.length ?? 0;
  if (tools.length === 0 && users.length < 2 && (users.length === 0 || earlierLoads + earlierProvided === 0)) return undefined;

  const sourceRef = `skill-task:${contentHashOf([input.sessionId, input.turnId])}`;

  return { sourceRef, taskId: input.turnId, versionId: input.sessionId,
    facts: [`Visible task completed its execution boundary; this does not assert task quality.`,
      `Observed tool results: ${tools.length}; non-success: ${tools.filter(item => item.outcome !== "succeeded").length}.`,
      `Additional inputs recorded with the user role within the turn: ${Math.max(0, users.length - 1)}. This is a transport role.`,
      `Current human attribution: ${input.userAttribution ?? "not_recorded"}. This does not establish confirmed human correction or permission; procedural tool evidence remains usable.`,
      `Earlier successful skill loads in the same session: ${earlierLoads}. Later transport input may contain feedback; interpretation belongs to Hermes.`,
      ...(earlierProvided === 0 ? [] : [`Earlier explicitly provided Hermes skills in the same session: ${earlierProvided}. Provision is not a skill_view or task-success verdict; interpretation belongs to Hermes.`])],
    evidenceRefs: [sourceRef] };
}
