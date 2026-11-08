import type { BoardCommand } from "./commands.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";
import { isMethodExperienceFact } from "../agent/subsystems/method/domain/experience-facts.js";
import { experienceFactError } from "../agent/subsystems/method/domain/experience-state.js";
import { experienceSourceOf } from "../agent/subsystems/method/domain/experience-source.js";

export function applyMethodExperience(state: BoardState,
  command: Extract<BoardCommand, { type: "record_method_experience" }>): ReduceResult {
  if (!isMethodExperienceFact(command.fact)) return fail(state, "invalid_feedback", "invalid_method_experience");
  const error = experienceFactError(experienceSourceOf(state), command.fact);
  if (error !== undefined) return fail(state, "invalid_feedback", error);
  return succeed(state, command.commandId, [{ type: "method_experience_recorded", sequence: nextSeq(state),
    commandId: command.commandId, occurredAt: command.issuedAt, fact: command.fact }],
  { methodExperienceFacts: [...(state.methodExperienceFacts ?? []), command.fact] });
}
