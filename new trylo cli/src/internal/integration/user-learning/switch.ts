import { LEARNING_SWITCH_METHOD } from "../method/wiring.js";

/**
 * `--learning` 的**总开关闭集**（UE-4 / WP §8-1；工具学习那一半由 TP-1 §12 补上）。
 *
 * 一个口进，三个子系统分别在各自那一半接。三件事钉在这里：
 *
 *  - **闭集与判据只有一处。** `isLearningSwitch` 是唯一判据，别的
 *    地方只传值不判值——宽容一个拼错的值会让它**静默**变成另一种行为，而开关的
 *    全部意义就是「我明确要它」。
 *  - **`method` 那一个字面量不在这里复制。** 它属于方法子系统的组合根
 *    （`integration/method/wiring.ts::LEARNING_SWITCH_METHOD`），这里 import 它。
 *    第二份字面量就是第二个会漂的地方。
 *  - **「`all` 要不要给方法子系统一个自己的取值」这个问题的答案是「不」。**
 *    `wireMethodLearning` 只认 `method` 一个字，所以 `surface/cli/wiring.ts` 在
 *    总开关开启 method 那一半时，交给它的是**它唯一的取值**——这不是第二个字面量，
 *    是同一个常量被转交。
 *
 * 三个判据（`switchEnablesMethod` / `switchEnablesUser` / `switchEnablesTool`）各自
 * 只认「自己那一个字」或 `all`，**没有一处把两个取值混着认**。于是「传了
 * `--learning=tool`，方法子系统却忽然也亮了」这种事在判据这一层就不可能发生。
 */

/** 用户学习那一半的取值。 */
export const LEARNING_SWITCH_USER = "user";

/** 工具学习那一半的取值（TP-1 §12；owner 2026-09-18 明确要一个独立取值）。 */
export const LEARNING_SWITCH_TOOL = "tool";
export const LEARNING_SWITCH_CHECK = "check";
export const LEARNING_SWITCH_SKILL = "skill";

/** 三半都开。 */
export const LEARNING_SWITCH_ALL = "all";
/** Agent capabilities without collecting User Learning or enabling checking. */
export const LEARNING_SWITCH_AGENT = "agent";

export const LEARNING_SWITCHES = [
  LEARNING_SWITCH_METHOD,
  LEARNING_SWITCH_USER,
  LEARNING_SWITCH_TOOL,
  LEARNING_SWITCH_CHECK,
  LEARNING_SWITCH_SKILL,
  LEARNING_SWITCH_ALL,
  LEARNING_SWITCH_AGENT,
] as const;

export type LearningSwitch = (typeof LEARNING_SWITCHES)[number];

/** 用法错误的提示里用的那句枚举文本，由闭集自己算，不再手写第二遍。 */
export const LEARNING_SWITCH_VALUES = LEARNING_SWITCHES.join("|");

export function isLearningSwitch(value: string | undefined): value is LearningSwitch {
  return value !== undefined && (LEARNING_SWITCHES as readonly string[]).includes(value);
}

export function switchEnablesMethod(value: LearningSwitch | undefined): boolean {
  return value === LEARNING_SWITCH_METHOD || value === LEARNING_SWITCH_ALL || value === LEARNING_SWITCH_AGENT;
}

export function switchEnablesUser(value: LearningSwitch | undefined): boolean {
  return value === LEARNING_SWITCH_USER || value === LEARNING_SWITCH_ALL;
}

/**
 * 工具学习那一半。
 *
 * 它有自己的取值，于是「只想让 Agent 反思工具、别动方法/用户学习」成了一句话说得
 * 出口的事——这是 owner 2026-09-18 明确要的，不是顺手加的。`all` 仍然含它。
 *
 * 代价与收获是一件事：多一个取值，就多一处「拼错会静默变成另一种行为」的地方，
 * 但收获是每个子系统都能单独开。闭集的价值在**判据只有一处**，不在成员少。
 *
 * 关学习（`undefined`）永远不含它，这是零差异的全部内容。
 */
export function switchEnablesTool(value: LearningSwitch | undefined): boolean {
  return value === LEARNING_SWITCH_TOOL || value === LEARNING_SWITCH_ALL || value === LEARNING_SWITCH_AGENT;
}

/** Executable checking requires its own explicit opt-in; the broad all switch does not enable it. */
export function switchEnablesCheck(value: LearningSwitch | undefined): boolean {
  return value === LEARNING_SWITCH_CHECK;
}

export function switchEnablesSkill(value: LearningSwitch | undefined): boolean {
  return value === LEARNING_SWITCH_SKILL || value === LEARNING_SWITCH_ALL || value === LEARNING_SWITCH_AGENT;
}

/** 交给 `wireMethodLearning` 的取值：它唯一的那个，或什么都不给。 */
export function methodSwitchFor(value: string | undefined): string | undefined {
  return isLearningSwitch(value) && switchEnablesMethod(value)
    ? LEARNING_SWITCH_METHOD
    : undefined;
}
