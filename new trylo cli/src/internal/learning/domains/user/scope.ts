import type { Scope } from "../shared/types.js";
import { detectsExplicitGlobal } from "./speech-act.js";

export type ScopeInput = {
  readonly text: string;
  readonly taskFamilyId?: string;
  readonly projectId?: string;
  readonly explicitGlobal?: boolean;
  readonly currentInstruction?: string;
};

export type ScopeDecision =
  | { readonly kind: "ok"; readonly scope: Scope }
  | { readonly kind: "too_broad"; readonly scope: Scope };

export function decideScope(input: ScopeInput, speechAct: string): ScopeDecision {
  const wantsGlobal = input.explicitGlobal === true || detectsExplicitGlobal(input.text);
  if (wantsGlobal) {
    if (speechAct === "future_directive" && detectsExplicitGlobal(input.text)) {
      return { kind: "ok", scope: { kind: "user_global", id: "user" } };
    }
    return {
      kind: "too_broad",
      scope: narrowScope(input),
    };
  }

  return { kind: "ok", scope: narrowScope(input) };
}

function narrowScope(input: ScopeInput): Scope {
  if (input.taskFamilyId !== undefined) {
    return { kind: "task_family", id: input.taskFamilyId };
  }

  if (input.projectId !== undefined) {
    return { kind: "project", id: input.projectId };
  }

  return { kind: "task", id: "current_task" };
}
