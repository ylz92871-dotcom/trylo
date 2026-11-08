import { FORBIDDEN_BOARD_ACTIONS } from "../learning/domains/shared/board-command.js";
import type { EvaluationEvidenceDraft, EvaluationRequest } from "./types.js";

export type GeneratorPort = {
  readonly role: "generator";
  readonly propose: true;
  readonly evaluate?: never;
};

export type EvaluatorPort = {
  readonly role: "evaluator";
  readonly evaluate: (request: EvaluationRequest) => EvaluationEvidenceDraft;
  readonly propose?: never;
};

export function generatorPort(): GeneratorPort {
  return { role: "generator", propose: true };
}

export function assertRoleSeparation(
  generator: object,
  evaluator: object,
): { readonly separated: true } {
  const generatorKeys = new Set(Object.keys(generator));
  const evaluatorKeys = new Set(Object.keys(evaluator));

  if (generatorKeys.has("evaluate")) {
    throw new Error("generator must not evaluate");
  }

  if (evaluatorKeys.has("propose")) {
    throw new Error("evaluator must not propose");
  }

  for (const action of FORBIDDEN_BOARD_ACTIONS) {
    if (generatorKeys.has(action) || evaluatorKeys.has(action)) {
      throw new Error(`role attempted forbidden action ${action}`);
    }
  }

  const generatorRole = "role" in generator ? String(generator.role) : "";
  const evaluatorRole = "role" in evaluator ? String(evaluator.role) : "";
  if (generatorRole !== "" && generatorRole === evaluatorRole) {
    throw new Error("generator and evaluator cannot share a role id");
  }

  return { separated: true };
}
