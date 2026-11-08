/** A bounded report of actual practice and observed result. It remains model
 * testimony; neither the report nor its absence creates an independent trial. */
export type MethodApplicationReport = {
  readonly practice: string;
  readonly result: string;
};

export const MAX_APPLICATION_REPORT_CHARS = 160;

export function isMethodApplicationReport(value: unknown): value is MethodApplicationReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && text(item.practice) && text(item.result);
}

export function sameApplicationReport(left: MethodApplicationReport | undefined,
  right: MethodApplicationReport | undefined): boolean {
  return left?.practice === right?.practice && left?.result === right?.result;
}

/** Correction idempotency only. Persist the original wording when a report
 * changes; whitespace normalization is not semantic equivalence or authority. */
export function sameNormalizedApplicationReport(left: MethodApplicationReport | undefined,
  right: MethodApplicationReport | undefined): boolean {
  const normalize = (value: string | undefined) => value?.trim().replace(/\s+/gu, " ");
  return normalize(left?.practice) === normalize(right?.practice) && normalize(left?.result) === normalize(right?.result);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_APPLICATION_REPORT_CHARS;
}
