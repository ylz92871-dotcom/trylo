import { contentHashOf } from "../../learning/control/hash.js";
import type { SkillTaskExtractionInput } from "./task-contract.js";

/** Identity binds a derived fact to the execution owner's qualified observation. */
export function skillTaskIdentity(input: Pick<SkillTaskExtractionInput, "workspaceId" | "sessionId" | "turnId"> & {
  readonly qualification: NonNullable<SkillTaskExtractionInput["qualification"]>;
}) {
  const owner = [input.workspaceId, input.sessionId, input.turnId];
  const correction = input.qualification.kind === "explicit_correction";

  return {
    episodeId: `${correction ? "skill-correction" : "skill-episode"}:${contentHashOf(correction
      ? [...owner, input.qualification.ref]
      : [...owner, input.qualification.kind, input.qualification.ref]).slice(0, 24)}`,
    runId: `${input.sessionId}:${input.turnId}`,
    sourceRef: `execution:${input.sessionId}:${input.turnId}#${input.qualification.ref}`,
  };
}
