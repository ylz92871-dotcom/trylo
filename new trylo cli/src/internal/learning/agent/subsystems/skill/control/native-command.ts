/** UI asset administration only. Learning proposals still originate in the Hermes review process. */
export const SKILL_NATIVE_METHODS = ["skillsQuery", "pendingList", "pendingDetail", "pendingApply", "pendingDiscard", "pendingBackupList", "pendingRollback"] as const;

export type SkillNativeMethod = typeof SKILL_NATIVE_METHODS[number];

export const isSkillNativeMethod = (value: unknown): value is SkillNativeMethod => typeof value === "string"
  && SKILL_NATIVE_METHODS.some(method => method === value);

export function isSkillNativeParameters(method: SkillNativeMethod, params: Readonly<Record<string, unknown>>): boolean {
  if (method === "pendingDetail" || method === "pendingApply" || method === "pendingDiscard") {
    if (params.subsystem !== "skills" || typeof params.id !== "string" || !params.id.trim()) return false;
    if (method === "pendingApply" && (typeof params.expectedHash !== "string" || !params.expectedHash.trim())) return false;
  }
  return method !== "pendingRollback" || typeof params.snapshotId === "string" && !!params.snapshotId.trim();
}
