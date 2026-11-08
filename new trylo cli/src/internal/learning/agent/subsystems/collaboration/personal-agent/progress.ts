type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const STRING_FIELDS = ["sourceRef", "kind", "memberId", "toolName", "status", "errorCode", "path", "reason", "component", "ignored", "attribution", "reportState", "reportExcerpt", "boundary", "resolvedFromBoundary"] as const;

/** Project useful facts before budgeting. Repeating full source coordinates can otherwise omit every real event. */
export function compactPersonalAgentFacts(values: readonly unknown[], maxChars = 1000): string {
  if (values.length === 0) return "";

  const source = values.filter(row), facts: Row[] = [];
  const data = { availableFacts: values.length, omittedFacts: values.length, facts, next: "collaboration_inspect for full source coordinates and current pending tools" };
  const pending = source.filter(value => value.kind === "tool_pending");
  const recent = source.filter(value => value.kind !== "tool_pending").reverse();

  for (const value of [...pending, ...recent]) {
    const projected: Row = {};

    for (const field of STRING_FIELDS) if (typeof value[field] === "string") projected[field] = value[field];

    if (typeof value.round === "number") projected.round = value.round;

    if (typeof value.late === "boolean") projected.late = value.late;

    if (typeof value.reportTextTruncated === "boolean") projected.reportTextTruncated = value.reportTextTruncated;

    if (projected.kind === undefined || projected.sourceRef === undefined) continue;

    facts.push(projected);
    data.omittedFacts--;

    if (JSON.stringify(data).length > maxChars) {
      facts.pop();
      data.omittedFacts++;
    }

    if (facts.length === 6) break;
  }

  return JSON.stringify(data);
}
