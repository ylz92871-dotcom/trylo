import type { Envelope } from "../../protocol/envelope.js";
import type { RewardInputPort } from "../../learning/reward/ports.js";
import type { RewardSensorPort, RewardSensorInput } from "./journal-sensor.js";

/** A bounded event inbox. It owns no reward state; successful writes always belong to the Board. */
export function createRewardObserver(options: {
  readonly input: RewardInputPort;
  readonly sensors: readonly RewardSensorPort[];
  readonly degraded: (reason: string) => void;
}): { readonly capture: (event: Envelope) => void; readonly flush: () => Promise<void> } {
  const inbox: RewardSensorInput[] = [];
  let unavailable = false;
  let draining: Promise<void> | undefined;
  const stop = (reason: string) => {
    if (!unavailable) options.degraded(reason);
    unavailable = true;
    inbox.length = 0;
  };
  async function drain(): Promise<void> {
    while (inbox.length > 0 && !unavailable) {
      const item = inbox.shift()!;
      try {
        const result = item.kind === "exposure"
          ? await options.input.expose(item.exposure) : await options.input.feedback(item.feedback);
        if (!result.ok) stop(result.reason);
      } catch { stop("reward_input_unavailable"); }
    }
  }
  return {
    capture: event => {
      if (unavailable) return;
      try {
        for (const sensor of options.sensors) {
          const items = sensor.capture(event);
          if (inbox.length + items.length > 256) { stop("reward_inbox_capacity"); return; }
          inbox.push(...items);
        }
      } catch { stop("reward_sensor_failed"); }
    },
    flush: () => {
      if (draining !== undefined) return draining;
      draining = drain().finally(() => { draining = undefined; });
      return draining;
    },
  };
}
