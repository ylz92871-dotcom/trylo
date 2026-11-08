import type { CollaborationRound } from "../../../../../subagent/collaboration.js";

const excerpt = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

type PendingToolSummary = { readonly toolName?: string };

/** This is bounded data, never clipped JSON containing a seemingly usable partial artifact or dependency reference. */
export function objectiveRoundContext(round: CollaborationRound, input: {
  readonly goal?: string; readonly originalAssignment?: string; readonly configuredToolNames?: readonly string[];
  readonly pendingTools: readonly PendingToolSummary[]; readonly maxChars: number;
}): string {
  const handoff = round.handoff, artifacts: string[] = [], dependencies: string[] = [], configuredToolNames: string[] = [];
  const pending: string[] = [], blockers: string[] = [], tools: { tool?: string; state: "no_result_observed" }[] = [];
  const handoffData = handoff === undefined ? undefined : { scope: excerpt(handoff.scope, 80), artifactCount: handoff.artifacts.length,
    artifacts, omittedArtifactRefs: handoff.artifacts.length, evidenceCount: handoff.evidence.length,
    pending, pendingCount: handoff.pending.length, blockers, blockerCount: handoff.blockers.length,
    textTruncated: handoff.scope.length > 80 || handoff.pending.length > 0 || handoff.blockers.length > 0 };
  const data = { goal: input.goal === undefined ? "unknown" : excerpt(input.goal, 80), assignment: excerpt(round.assignment, 120),
    ...(input.originalAssignment === undefined || input.originalAssignment === round.assignment ? {} : { originalAssignment: excerpt(input.originalAssignment, 80) }),
    textTruncated: round.assignment.length > 120 || (input.goal?.length ?? 0) > 80 || (input.originalAssignment?.length ?? 0) > 80,
    handoff: handoffData ?? "absent", dependencies, dependencyCount: round.dependencies.length, omittedDependencyRefs: round.dependencies.length,
    pendingTools: tools, pendingToolCount: input.pendingTools.length, configuredToolNames,
    configuredToolCount: input.configuredToolNames?.length ?? "unknown", omittedConfiguredToolNames: input.configuredToolNames?.length ?? "unknown" };
  const prefix = "Objective context (observed data only; textTruncated marks prose excerpts; no permission or quality verdict):\n";
  const fits = () => prefix.length + JSON.stringify(data).length <= input.maxChars - 32;
  if (!fits()) return excerpt("[Objective context omitted: allowance cannot fit complete bounded metadata; original execution records remain authoritative.]", input.maxChars);

  const add = <T>(target: T[], value: T) => {
    target.push(value);
    if (!fits()) target.pop();
  };

  // Reference strings remain exact or are omitted whole. Counts preserve the difference from an absent dependency/handoff.
  for (const ref of handoff?.artifacts.slice(0, 2) ?? []) if (ref.length <= 512) add(artifacts, ref);

  for (const ref of round.dependencies.slice(0, 4)) if (ref.length <= 512) add(dependencies, ref);

  for (const item of handoff?.pending.slice(0, 2) ?? []) add(pending, excerpt(item, 70));

  for (const item of handoff?.blockers.slice(0, 2) ?? []) add(blockers, excerpt(item, 70));

  for (const tool of input.pendingTools) add(tools, { ...(tool.toolName === undefined || tool.toolName.length > 80 ? {} : { tool: tool.toolName }), state: "no_result_observed" });

  for (const name of input.configuredToolNames?.slice(0, 8) ?? []) if (name.length <= 80) add(configuredToolNames, name);

  if (handoffData && handoff) {
    handoffData.omittedArtifactRefs -= artifacts.length;
    handoffData.textTruncated = handoff.scope.length > 80 || pending.length !== handoff.pending.length || blockers.length !== handoff.blockers.length
      || [...handoff.pending, ...handoff.blockers].some(item => item.length > 70);
  }

  data.omittedDependencyRefs -= dependencies.length;

  if (typeof data.omittedConfiguredToolNames === "number") data.omittedConfiguredToolNames -= configuredToolNames.length;

  return prefix + JSON.stringify(data);
}
