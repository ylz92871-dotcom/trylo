/**
 * A 描述精炼（P05 工具学习规格 §6）的对外面。
 *
 * 出口与意识层同一条纪律：**只导出「怎么判」和「判要用的形状」**，不导出 IO、
 * 不导出写路径、不导出执行环类型。所以组合层拿到的全是纯函数，「覆盖层默认
 * shadow、只有人审才 enforced」在这里是字面事实而不是一句要记得遵守的纪律。
 *
 * 与意识层的关系：意识层决定**要不要换/升级**（决策树两支），这一层是升级的
 * 轻档（A）**本身的语义**。决策树说「先试 A」，然后 A 从这里开始。
 */

export {
  REFINE_MAX_DESCRIPTION_LENGTH,
  REFINE_MAX_HISTORY,
  REFINE_MIN_EVIDENCE,
  REFINE_SIMILARITY_CONVERGED,
} from "./constants.js";
export {
  guardRefinedText,
  hashOf,
  isConverged,
  noOverlay,
  overlayFor,
  promoteToEnforced,
  refineEntryFor,
  resolveDescription,
  rollbackToShadow,
  shouldProposeRefinement,
} from "./overlay.js";
export { converged, similarityOf, tokensOf } from "./similarity.js";
export type {
  DescriptionOverlay,
  RefineTriggerInput,
  RefineTriggerVerdict,
  RefinementEntry,
  RefinementState,
  RefinementStore,
  RefinementVersion,
} from "./types.js";
