import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";

/** Historical Board vocabulary remains readable; retired owners cannot receive new topic work. */
export function isActiveTopicDomain(value: unknown): value is LearningDomain {
  return typeof value === "string" && value !== "routing" && LEARNING_DOMAINS.some(domain => domain === value);
}
