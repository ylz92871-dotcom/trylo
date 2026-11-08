import { createMethodBoard, type MethodBoard } from "../orchestration/board.js";
import type { MethodEventSink } from "../port.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceStore } from "./experience-store.js";
import { createExperienceRuntime } from "../orchestration/experience-runtime.js";
import { reviseExperience } from "./experience-revision.js";
import type { ExperienceModelPort } from "../experience-port.js";
import { correctExperience } from "./experience-correction.js";

/**
 * 方法子系统的组合根。
 *
 * 规格 §9 要的次序是：**先有开关**，开关开了才构造档、才读一次、才造板；开关没
 * 开则一个对象都不造。这个文件就是那句「才」，而它把两件事说清楚：
 *
 *  - **名字只定一处。** 开关的取值是闭集 `["method"]`，写在 `LEARNING_SWITCH_METHOD`。
 *    规格原文是「命名在施工时定一次并只定一处」，所以别处不许再出现第二个字面量
 *    ——`isMethodLearning` 是唯一判据，`surface/cli/wiring.ts` 只传值不判值。
 *  - **`boardRoot` 由调用方给，不由本文件算。** 家目录的公式是
 *    `surface/cli/session-paths.ts::tryloHome`，唯一一份；子系统适配器比
 *    表面层更靠里，在这里再拼一次路径就会出现第二个家（反方表 #19）。
 *
 * 构造时仍先读共享档。经验runtime在规划边界刷新canonical Board，保证并行反馈、
 * 撤回和新编译能改变下一枪；旧board内存只承载自己的短期释放账与归档投影。
 * 这是显式的读成本，不能再宣称开启经验后每拍零读盘；writer与锁仍只有共享Board。
 */

/**
 * 开关的唯一取值。
 *
 * 闭集只有一个成员，因为 M2 只有方法这一个子系统：将来若出现第二个，这里是
 * 一行联合类型，而不是一个布尔。
 */
export const LEARNING_SWITCH_METHOD = "method";

export type MethodLearningSwitch = typeof LEARNING_SWITCH_METHOD;

/**
 * 这个值开不开方法学习。
 *
 * `undefined` 与任何别的字符串都是「不开」——包括 `"off"`、`"true"`、`"Method"`
 * （大小写不做宽容：宽容会让一个拼错的值**静默**变成另一种行为，而开关的全部
 * 意义就是「我明确要它」）。
 */
export function isMethodLearning(value: string | undefined): value is MethodLearningSwitch {
  return value === LEARNING_SWITCH_METHOD;
}

export type MethodWiringInput = {
  readonly model?: ExperienceModelPort;
  /** 开关取值。缺席 = 不构造（默认路径）。 */
  readonly switch?: string | undefined;
  /** 档的根目录，由组合根用 `tryloHome(...) + "/learning/board"` 算出。 */
  readonly boardRoot: string;
  /** ISO-8601 时刻。学习层不读时钟，所以由组合根注入。 */
  readonly now: () => string;
  /** 板上决策写到哪里去。必填：没有 sink 的板是不可观察的板。 */
  readonly emit: MethodEventSink;
};

/**
 * 开关没开就是 `undefined`，开了就是一块**已经发起读档**的板。
 *
 * 返回 `undefined` 而不是一块空板，是为了让「关学习」这条路连一次 `load()` 都不
 * 发生——I1 要的字节级一致由「组合根拿不到端口」保证，而不是由空板的行为保证
 * （空板仍然会 `mkdirSync` 与试锁，那是两件可观察的事）。
 */
export function wireMethodLearning(input: MethodWiringInput): MethodBoard | undefined {
  if (!isMethodLearning(input.switch)) {
    return undefined;
  }

  const archive = createMethodBoardWriter(input.boardRoot);
  const experience = createExperienceRuntime({ store: createExperienceStore(input.boardRoot, input.now),
    correct: (id, outcome, reason, application) => correctExperience(input.boardRoot, archive, input.now, id, outcome, reason, application),
    revise: (versionId, hint) => reviseExperience(archive, input.now, versionId, hint), emit: input.emit,
    ...(input.model === undefined ? {} : { model: input.model }) });

  return createMethodBoard({
    archive,
    experience,
    emit: input.emit,
    now: input.now,
  });
}
