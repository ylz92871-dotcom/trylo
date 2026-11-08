export type CollaborationLearningOption = "off" | number;

export const DEFAULT_COLLABORATION_TOKENS = 16000;

/** Separate from user/method/tool learning. Omission enables only frozen teams. */
export function parseCollaborationLearningOption(raw: string | undefined): CollaborationLearningOption | undefined | "invalid" {
  if (raw === undefined || raw === "off") return raw;
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= 256 && value <= 64000 ? value : "invalid";
}
