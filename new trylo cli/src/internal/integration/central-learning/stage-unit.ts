import { contentHashOf } from "../../learning/control/hash.js";

/** One observed physical stage. Late qualification revises this unit. */
export const centralStageUnitId = (grantId: string, stageRef: string): string =>
  `central-stage-unit:${contentHashOf([grantId, stageRef])}`;
