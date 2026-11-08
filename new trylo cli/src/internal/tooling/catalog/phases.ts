export type ToolUsePhase = "discovery" | "schema_load" | "execution";

export type PhaseFailure = "schema_not_loaded" | "not_discovered" | "execution_before_schema";

export function nextToolUsePhase(
  current: ToolUsePhase,
  action: "search" | "load_schema" | "execute",
): ToolUsePhase | PhaseFailure {
  if (action === "search") {
    return "discovery";
  }

  if (action === "load_schema") {
    return current === "discovery" || current === "schema_load" ? "schema_load" : "not_discovered";
  }

  if (current !== "schema_load") {
    return "execution_before_schema";
  }

  return "execution";
}

export function executionRequiresSchema(phase: ToolUsePhase): boolean {
  return phase === "schema_load";
}
