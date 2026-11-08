import { createSkillLifecycleObserver } from "../../learning/agent/subsystems/skill/host/index.js";
import { createRewardV2BoardPort } from "../../integration/reward/v2-board-port.js";
import { skillDailyBoard } from "./skill-daily-board.js";

/** Thin composition over the original Board. Native approval remains the only
 * writer of skills; these source-bound observations confer no authority. */
export function hermesSkillLifecycle(boardRoot: string, enabled: () => boolean) {
  const reward = createRewardV2BoardPort(boardRoot, enabled);
  return createSkillLifecycleObserver({ board: skillDailyBoard(boardRoot), enabled,
    append: (revision, draft) => reward.append(revision, draft) });
}
