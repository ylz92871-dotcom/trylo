import type { CollaborationExperienceContent } from "./contracts.js";

/** A whole card is admitted or omitted. Cutting instructions would change the learned practice. */
export function renderExperience(content: Pick<CollaborationExperienceContent, "situation" | "responsibilities" | "practice">): string {
  return `专项协作经验（试用）\n情境：${content.situation}\n职责：${content.responsibilities.join("；")}\n做法：${content.practice}`;
}
