import { createCollaborationDriverV2 } from "./driver-v2.js";
import { createCollaborationTimelineV2 } from "./timeline-v2.js";
import { createCollaborationParentSlotV2 } from "./parent-slot-v2.js";
import { createCollaborationControlObserverV2 } from "./control-observer-v2.js";
import { createCollaborationMemberPortV2 } from "./member-port-v2.js";
import type { SessionOptionsV2 } from "./session-types-v2.js";

/** One composition instance shares evidence, bounded advice and one independent learning worker. */
export function createCollaborationSessionV2(input: SessionOptionsV2) {
  const options: SessionOptionsV2 = { ...input, warn: reason => {
    try { input.warn(reason); }
    catch { /* Diagnostics are observers; they cannot fail execution or the learning worker. */ }
  } };
  const driver = createCollaborationDriverV2(options);
  const timeline = createCollaborationTimelineV2(options, driver.wake);
  const parent = createCollaborationParentSlotV2(options, timeline);
  const controls = createCollaborationControlObserverV2(options, timeline, parent.latestExposure);
  const member = createCollaborationMemberPortV2(options, timeline, controls.delivered);
  let parentFinished = false;
  const finish = async (result: { readonly reason: string; readonly usage?: { readonly totalTokens: number }; readonly usageReported?: boolean }) => {
    if (parentFinished) return;

    parentFinished = true;
    await timeline.flush();

    if (result.usageReported && result.usage !== undefined) await timeline.usage(timeline.context(), `parent:${options.turnId}`, result.usage.totalTokens);

    await timeline.event({ id: `${options.turnId}:parent-terminal`, context: timeline.context(), dimension: "review", action: "team_terminal", terminalMetadata: true,
      summary: `Parent execution ended with ${result.reason}. Delivery quality remains unverified.`, evidenceRefs: [`turn:${options.turnId}`] });
    await timeline.episode(timeline.context(), { delivery: "unverified" }, true, true);
  };

  return {
    member,
    attachParent: parent.attach,
    wrapParentTools: controls.wrap,
    capture: timeline.capture,
    start: driver.wake,
    finish,
    async drain() {
      await timeline.flush();
      await driver.drain();
    },
    async close() {
      if (!parentFinished) await finish({ reason: "unknown" });
      await timeline.flush();
      await driver.close();
    },
  };
}

export type CollaborationSessionV2 = ReturnType<typeof createCollaborationSessionV2>;
