/**
 * 执行环 → 用户学习的强信号映射（UE-3 的纯函数那一半）。
 *
 * 执行环手里有一样学习侧查不到的东西：**这一轮真的发生了什么**。这个文件把它缩成
 * 一个判别联合——一次只可能落一类信号，或者什么都不落。它的形状刻意与
 * `protocol/envelope.ts::Envelope` 结构兼容，但**不 import 它**：学习层不依赖协议
 * 包，于是「学习层只吃一份事实视图」是类型上的事实而不是一句约定（`io-boundary`
 * 会拦的是 `adapters|loop|desktop|permission|surface`，这里连一行 import 都不需要）。
 *
 * 三条规则：
 *
 *  - **只认强信号（D5）。** 白名单之外的事件一律 `undefined` —— 不埋 trace、不攒
 *    全量、不把 `text_delta` 一条条写进账。账本的价值在于它短。
 *  - **绑运行身份（D6）。** 每条信号都带 `eventId` / `sessionId` / `turnId`，它们
 *    来自 envelope 本身，学习层**不自己造**身份。于是「证据属于哪一次运行、当时
 *    发生了什么」是执行事实的回声，不是学习环的叙述。
 *  - **文本随信号走。** 用户说的那句话原样带出来（`rawText` 逐字保存是
 *    `contracts.ts::UserEvidence` 的硬边界）；信号本身没有文本时如实为 `undefined`，
 *    绝不替它编一句。
 */

import type { StrongSignalKind } from "./scheduler-ports.js";

/** 一条 journal 事件的最小视图：执行环已经写下的事实。 */
export type JournalEvent = {
  readonly kind: string;
  readonly eventId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type StrongSignal = {
  readonly signal: StrongSignalKind;
  /** 用户自己的那句话；这一格没有文本时为 `undefined`。 */
  readonly text?: string;
};

/**
 * 事件种类 → 信号种类。
 *
 * 这张表是**对协议闭集**（`protocol/kinds.ts::EVENT_KINDS`）的子集取像，不是对
 * 「今天执行环会发的那些」。差别在两处，都写明白：
 *
 *  - `turn_start` → `steer`。开幕那一拍带的是用户自己的那句话（`{turnId, text}`），
 *    而 `steer` 正是「用户说了话，让这一轮照它走」——它是不是一条偏好，由资格闸判，
 *    不由这里判。
 *  - `user_correction` → `correction`。中途插话（D 波的 `user_input`，mode 为 steer
 *    或 queue 都走这条）在 journal 里就是这个 kind，载荷是 `{text}`。
 *  - `permission_denied` → `reject`。人拒绝了这次调用；`resolution` 只说它是被拒还是
 *    过期，两者对「用户不要这个」是同一种事实。执行环里**没有**「同意」这个事件
 *    （只有 `approval_requested`，那是问题不是回答），所以 `approve` 目前没有生产
 *    来源——闭集留着它，见 `OPEN-UE-1`。
 *  - `user_reject` → `reject`。协议词表里有它、执行环今天不发；留在这一行是因为本题
 *    观察的是 `Envelope`，而别的表面（ACP / AGUI 映射）可以发它。
 */
const SIGNAL_OF_KIND: Readonly<Record<string, StrongSignalKind>> = {
  turn_start: "steer",
  user_correction: "correction",
  user_cancel: "interrupt",
  permission_denied: "reject",
  user_reject: "reject",
  file_write: "artifact",
};

/** 会带用户文本的那两种；其余是「发生了」而不带话。 */
const TEXT_KINDS = new Set(["turn_start", "user_correction"]);

function textOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload["text"];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 一次事件 → 一条强信号，或什么都不落。
 *
 * 「没带文本就不是证据」这条**不是**在编：`steer` 之外的信号（打断、拒绝、产物）
 * 表达的是「发生了什么」，用户一个字都没说，那就没有一个 `rawText` 可逐字保存。
 * 硬给它们编一句人话，等于把推断写成用户明令——那正是总纲领红线里最不能碰的一条。
 * 于是它们以「信号」的身份进账（带运行身份），而不是以「证据」的身份。
 */
export function strongSignalOf(event: JournalEvent): StrongSignal | undefined {
  const signal = SIGNAL_OF_KIND[event.kind];
  if (signal === undefined) {
    return undefined;
  }

  if (!TEXT_KINDS.has(event.kind)) {
    return { signal };
  }

  const text = textOf(event.payload);

  return text === undefined ? undefined : { signal, text };
}
