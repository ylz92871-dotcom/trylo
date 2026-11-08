import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import type { AcpDisposition, AcpPrimitive } from "../../protocol/acp-map.js";
import type { AguiDisposition } from "../../protocol/agui-map.js";
import type { AcpAgentState } from "../../protocol/terminal-map.js";

/**
 * 两个目标形状的帧类型（「形状对齐、类型自有」）。
 *
 * 这些类型是 Trylo 自己的：字段名与 ACP `SessionUpdate` / ag-ui `EventType`
 * 对照后手写，但**没有**引入上游 SDK 类型、也没有复制上游 schema 代码。
 * 上游仓库只作为对照阅读材料（WP §1 末段）。
 *
 * 两个共有的设计决定：
 *
 * - `source` 是**必填**。任何一帧都能指回产生它的 envelope
 *   （`eventId`/`sequence`/`kind`），CUSTOM 帧因此不可能为空
 *   （WP §5 第 5 条）。
 * - `omitted` 是**必填**（可以为空数组）。目标形状需要、而 Trylo 事实源里
 *   没有的字段必须在这里显式登记，缺字段就省略，绝不虚构（WP §2.5）。
 *
 * 帧体里的「Trylo 侧注解区块」（`lineage` / `terminal`）与目标协议的原生字段
 * 刻意在形状上分开：它们是**投影层的决定**，不该看起来像事实源本来就有。
 */

/** 来源坐标。CUSTOM 帧靠它重建，普通帧靠它回溯。 */
export type FrameSource = {
  readonly eventId: string;
  /** `Envelope.sequence`（per-attempt），不是传输层序号。 */
  readonly sequence: number;
  readonly kind: string;
};

export type AcpFrame = {
  readonly surface: "acp";
  readonly disposition: AcpDisposition;
  readonly primitive: AcpPrimitive;
  /** ACP `SessionUpdate` 变体名；`custom` 帧为 `null`。 */
  readonly variant: string | null;
  readonly agentState: AcpAgentState;
  readonly body: JsonObject;
  readonly source: FrameSource;
  readonly omitted: ReadonlyArray<string>;
};

export type AguiFrame = {
  readonly surface: "agui";
  readonly disposition: AguiDisposition;
  readonly type: string;
  readonly body: JsonObject;
  readonly source: FrameSource;
  readonly omitted: ReadonlyArray<string>;
};

export type SurfaceFrame = AcpFrame | AguiFrame;

/**
 * 投影失败码。只有两个，且都是**显式失败**（fail closed），
 * 不抛异常、也不降级成「看起来成功的空帧」。
 */
export type SurfaceProjectionFailure =
  /** envelope 的 kind 不在 `EVENT_KINDS` 里（正常路径由 admit 拦掉，防御性保留） */
  | "unknown_kind"
  /** payload 缺少该 kind 的必需字段或类型不符（见 `protocol/payload-contract.ts`） */
  | "payload_contract_violation";

export type ProjectionResult<T> =
  | { readonly ok: true; readonly frame: T }
  | { readonly ok: false; readonly code: SurfaceProjectionFailure; readonly detail: string };

/**
 * 冻结一帧。
 *
 * 为什么这里有一份深冻结：传输端口承诺「live 与 replay 是同一批字节」，
 * 而 replay 返回的就是 log 里的对象本身——只要有一个订阅者改了 `body`，
 * 后来的 replay 就会拿到被改过的字节，承诺就破了。
 *
 * `protocol/validate.ts` 里有一份同语义的私有 `deepFreeze`，但它只作用于
 * `Envelope.payload`：帧的 `body` 是投影层**新建**的容器（`buildBody` 会把
 * 已经冻结的 payload 值放进新对象），拿不到那份实现。`validate.ts` 属于
 * 本包写入集的禁改文件，因此不做提取，只在此处保留一份并说明来源。
 */
export function freezeFrame<T extends SurfaceFrame>(frame: T): T {
  freezeJsonValue(frame.body);
  Object.freeze(frame.omitted);
  return Object.freeze(frame);
}

/**
 * 深冻结一个 JSON 值，幂等。
 *
 * 导出它是为了让传输端口在 `append` 时能对**任意来源**的帧体做同样的保护：
 * 「live 与 replay 是同一批字节」这条承诺不能被一个没走投影器的调用方破掉。
 */
export function freezeJsonValue(value: JsonValue): void {
  if (typeof value !== "object" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJsonValue(item);
    }
    Object.freeze(value);
    return;
  }

  const record = value as JsonObject;

  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child !== undefined) {
      freezeJsonValue(child);
    }
  }

  Object.freeze(record);
}
