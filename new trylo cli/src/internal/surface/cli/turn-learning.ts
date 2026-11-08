import type { TurnHostInput } from "./host.js";
import { createUserLearningRuntimeFor } from "./user-learning-config.js";
import { userLearningObserver } from "../../integration/user-learning/index.js";
import { topicRuntimeFor } from "./topic-wiring.js";
import { combineEnvelopeObservers } from "./envelope-observers.js";

/** One per-turn instance per learning domain; the same topic instance reaches observer and slot wiring. */
export function createTurnLearning(input: TurnHostInput) {
  const userLearning = input.userLearning === undefined ? undefined : createUserLearningRuntimeFor(input.userLearning);
  const topics = topicRuntimeFor(input);
  const observe = userLearning === undefined && topics === undefined ? undefined
    : combineEnvelopeObservers(userLearning === undefined ? undefined : userLearningObserver(userLearning), topics?.capture);
  return { userLearning, topics, observe };
}
