import type { TurnHostInput } from "./host.js";
import { methodBoardRoot, createMethodEventSink, methodLearningRoot } from "./learning-sink.js";
import { isLearningSwitch } from "../../integration/user-learning/switch.js";
import { createRewardCatalog } from "../../learning/reward/catalog.js";
import { createRewardBoardPort } from "../../integration/reward/board-port.js";
import { createRewardGateway } from "../../integration/reward/gateway.js";
import { createRewardObserver } from "../../integration/reward/observer.js";
import { createToolRewardSensor, TOOL_EXECUTION_METRIC } from "../../integration/reward/journal-sensor.js";
import { identity } from "../../learning/reward/validate.js";
import { contentHashOf } from "../../learning/control/hash.js";

/** Explicit experiment switch preserves all existing learning modes until the owner enables RW1. */
export async function rewardObserverFor(input: TurnHostInput, catalogHash: string): Promise<ReturnType<typeof createRewardObserver> | undefined> {
  const host = input.learning;
  if (host === undefined || !isLearningSwitch(host.switch) || host.env.TRYLO_REWARD_FEEDBACK !== "1") return undefined;
  const warn = (reason: string) => input.sink.stderr(`warning: reward_degraded:${reason}\n`);
  const runtimeRevision = host.env.TRYLO_REWARD_RUNTIME_REVISION;
  if (!identity(runtimeRevision)) { warn("reward_runtime_revision_required"); return undefined; }
  const ledger = createRewardBoardPort(methodBoardRoot(host.homeDir, host.env));
  const basis = await ledger.read();
  if (!basis.ok) { warn(basis.reason); return undefined; }
  const telemetry = createMethodEventSink(methodLearningRoot(host.homeDir, host.env), {
    now: () => new Date(input.now()).toISOString(), warn,
  });
  const gateway = createRewardGateway({ enabled: () => true,
    catalog: createRewardCatalog({ metrics: [TOOL_EXECUTION_METRIC], objectKinds: ["tool"] }),
    ledger, degraded: warn,
    output: { replace: async projection => {
      telemetry("observation", { component: "reward_feedback", revision: projection.revision,
        activeSignals: projection.signals.length });
    } },
  });
  return createRewardObserver({ input: gateway, degraded: warn, sensors: [createToolRewardSensor({
    scope: input.workspaceRoot, environment: contentHashOf([runtimeRevision, input.providerId, input.model, catalogHash]),
  }, basis.records.feedbacks.length)] });
}
