import type { TurnHostInput } from "./host.js";
import type { TopicLearningRuntime } from "../../integration/learning-topics/runtime.js";
import { createReadStrategyRuntime } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { isLearningSwitch, switchEnablesTool } from "../../integration/user-learning/switch.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./wiring-catalog.js";

export function toolReadStrategyEnabled(input: Pick<TurnHostInput, "learning">): boolean {
  return isLearningSwitch(input.learning?.switch) && switchEnablesTool(input.learning.switch);
}

/** Execution consumes tool-owned read strategies; only the existing central topic grant can run a study. */
export function toolReadStrategyFor(input: Pick<TurnHostInput, "learning" | "workspaceRoot" | "sessionId" | "turnId" | "now">,
  topics: Pick<TopicLearningRuntime, "ownsReadRouting" | "bindReadRuntime" | "offerReadOpportunity"> | undefined) {
  const host = input.learning;
  if (host === undefined || !toolReadStrategyEnabled(input)) return undefined;

  const runtime = createReadStrategyRuntime({ boardRoot: methodBoardRoot(host.homeDir, host.env), scope: workspaceIdentity(input.workspaceRoot),
    sessionId: input.sessionId, turnId: input.turnId, enabled: () => toolReadStrategyEnabled(input), nowMs: input.now });

  if (topics?.ownsReadRouting === true) topics.bindReadRuntime(runtime);

  return { choose: runtime.choose, record: runtime.record,
    offer: (opportunity: Parameters<TopicLearningRuntime["offerReadOpportunity"]>[0]) => topics?.offerReadOpportunity(opportunity) };
}
