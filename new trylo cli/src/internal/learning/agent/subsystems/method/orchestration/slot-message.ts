import type { LabelVocabulary } from "../domain/contracts.js";
import { LEARNING_FENCE, LEARNING_INTENT_MARKER, METHOD_FEEDBACK_FENCE } from "../domain/message-contract.js";
import type { FieldedHint, MethodSlotDelivery, SlotMessageInput } from "../port.js";
import { slotLineFor } from "./compile.js";

/**
 * 编成**一条** `system` 消息，两个可选段落。
 *
 * 一条而不是 N 张卡 N 条 system：注入点是消息列表的尾部，多一条消息就多一次
 * 「这段是谁说的」的判断，而槽里的经验既不是用户说的也不是助手说的——它和压缩
 * 摘要一样，是在**谈论**这段对话而不是在对话里。
 *
 * 两段都缺 → `undefined`。返回 `undefined` 而不是空串，是让调用方走「不注入」
 * 这一条路（`withInjectedSlot` 对 `undefined` 是恒等），于是「关学习」与「开着
 * 但这一拍什么都没编出来」在字节上不可区分——I1 由构造保证，不靠约定。
 */
export function methodMessage(input: SlotMessageInput): MethodSlotDelivery | undefined {
  const segments = [
    slotSegment(input.fielded),
    feedbackSegment(input.fielded),
    input.intent ? intentSegment(input.vocabulary) : undefined,
  ].filter((segment): segment is string => segment !== undefined);
  if (segments.length === 0) {
    return undefined;
  }

  return {
    message: { role: "system", content: segments.join("\n") },
    // 只有**渲染进这一段文本**的那些条才产生 receipt：槽是空的时候这里必须是
    // 空数组，否则「无选中卡却记了一条上场」就成了可能。
    receipts: input.fielded.map((item) => item.receipt),
  };
}

function slotSegment(fielded: ReadonlyArray<FieldedHint>): string | undefined {
  if (fielded.length === 0) {
    return undefined;
  }

  const lines = [
    "[method slot] 本轮可用的方法经验（来自你自己的档案，尚未经独立验证）：",
    // 渲染只有一处实现（`compile.ts::slotLineFor`），计费量的就是同一个函数。
    ...fielded.map((item) => slotLineFor(item.receipt.ref, item.hint)),
  ];

  return lines.join("\n");
}

/**
 * 反馈请求段（ME0-3）。
 *
 * 只在**真的有卡上场**时渲染（`fielded.length > 0`），所以空槽与关学习都拿不到这
 * 一段——provider 请求逐字节不变（F12）。它告诉模型：回答完之后，就上面每条经验
 * 是否真的帮到了你，追加一个 `trylo-method-feedback` 块，形状是闭集
 * `{items:[{ref,helped}]}`，ref 用上面的短引用，helped 只能是 true/false。
 *
 * 「没把握或没用到的不要写」是承重的：缺失会被记为 unknown，绝不会被当成 false
 * （F05）。于是模型沉默不等于「这些卡都没用」，账上分得开「没说」与「说了没用」。
 */
function feedbackSegment(fielded: ReadonlyArray<FieldedHint>): string | undefined {
  if (fielded.length === 0) {
    return undefined;
  }
  return [
    "[method feedback] 回答完成后，就上面每条经验是否真的帮到了你，追加一个 ```" +
      METHOD_FEEDBACK_FENCE +
      " 块。",
    '形状严格为 {"items":[{"ref":"m1","helped":true}]}：ref 用上面的短引用，helped 只能是 true 或 false。',
    '可选application:{"practice":"实际做法","result":"已观察结果"}，两项各不超160字符；只报实际使用，不预测工具成功。',
    "没把握或没用到的条目不要写——缺失会被记为 unknown，绝不会被当成 false。该块不会展示给用户。",
  ].join("\n");
}

/**
 * 学习意图。
 *
 * 两件事写在里面：怎么交（围栏块）、以及能用的词。词表**全量**打出来，因为
 * 受控子集的全部意义就是「可见才可控」；模型看不到全表就会造词，然后被门拒掉。
 *
 * 卡片形状那一行包含了 `addLabels`。规格 §8.4 那一行只列到 `hook`，但 §4.3 要求
 * 追加带释义，而模型不会去猜一个没告诉它的字段——不写出来，词表就只能靠种子六
 * 个词，追加机制等于不存在。加宽的是同一行的列举，不是加字段。
 */
function intentSegment(vocabulary: LabelVocabulary): string {
  return [
    LEARNING_INTENT_MARKER + " 这一拍除了干活，若你刚看到任何失败模式，请在正常回答之后追加一个 " +
      `${LEARNING_FENCE} 块。`,
    `可用标签：${vocabulary.known.join(", ")}`,
    '卡片形状：{"hint":...,"appliesWhen":...,"labels":[...],"family":...,' +
      '"addLabels":[{"id":...,"gloss":...}],"hook":{"labels":[...],"need":...}}',
  ].join("\n");
}
