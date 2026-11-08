import type { ToolBinding, ToolPort } from "../ports/tools.js";
import { isTeamRepresentation, type TeamRepresentation } from "../protocol/team-representation.js";

export const REPRESENTATION_REPORTING_INSTRUCTIONS = "Submit the current user's scope through report_representation with intent, vetoes, user_questions and representation_notes. Vetoes are current unresolved objections to the proposed implementation, or an actual user stop/hold. Standing constraints that the proposed work already obeys belong in representation_notes; they do not by themselves veto authorized work. Keep every real unresolved objection and question; never clear one merely to release implementation. Use an empty vetoes array only when you judge that no current objection remains, while preserving all standing constraints in the notes. This records representation only: it grants no tools, approvals or quality acceptance. A normal-language final answer is welcome; the runtime creates legacy section formatting.";
const binding: ToolBinding = {
  name: "report_representation", description: "Submit the frozen Person member's current representation. Nonempty vetoes or user_questions keep all implementation held. Record compliant standing boundaries in the notes, and current unresolved objections in vetoes. This is not permission or quality approval.",
  sideEffect: "read_only", needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 256, maxLines: 3 },
  parameters: { type: "object", additionalProperties: false, properties: {
    intent: { type: "string", minLength: 1, maxLength: 12000 },
    vetoes: { type: "array", maxItems: 16, description: "Current unresolved objections to the proposed implementation or a user stop/hold. Do not list hypothetical prohibited actions that the proposed work does not take; retain those standing constraints in representation_notes. Empty only when no actual objection remains.", items: { type: "string", minLength: 1, maxLength: 2000 } },
    user_questions: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 2000 } },
    representation_notes: { type: "string", maxLength: 12000 },
  }, required: ["intent", "vetoes", "user_questions", "representation_notes"] },
};

/** Mounted only by the frozen Person's owner, around already-attenuated execution tools. */
export function withRepresentationReporting(tools: ToolPort, submit: (value: TeamRepresentation) => Promise<boolean>): ToolPort {
  return {
    snapshot: () => [...tools.snapshot().filter(tool => tool.name !== binding.name), binding],
    execute: async (call, signal) => {
      if (call.name !== binding.name) return tools.execute(call, signal);

      if (signal.aborted) return { outcome: "cancelled" };

      if (!isTeamRepresentation(call.arguments)) return { outcome: "error", code: "invalid_team_representation",
        message: "Provide intent, vetoes[], user_questions[] and representation_notes, within the declared limits." };

      const accepted = await submit(structuredClone(call.arguments));
      if (!accepted) return { outcome: "error", code: "team_representation_stale", message: "Newer input or another execution superseded this representation; represent the current scope." };

      return { outcome: "result", value: { recorded: true }, output: "Representation recorded; implementation remains held until this round completes and the existing gate checks it.", truncated: false };
    },
    cancel: id => tools.cancel(id),
  };
}
