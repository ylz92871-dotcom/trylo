import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { MethodEventPayload, MethodEventSink } from "../../learning/agent/subsystems/method/index.js";
import { tryloHome } from "./session-paths.js";
import type { MethodLearningInput } from "./wiring.js";

/**
 * 方法子系统决策事件的落点。
 *
 * 板（`learning/method/board.ts`）只 `emit("observation", …)`，它自己不知道
 * 决策写到哪里去——`MethodEventSink` 是组合根借给它的东西。测试里那个 sink 是
 * 一个收集器；这个文件是生产里第一个真正的实现。
 *
 * 三件事钉在这里：
 *
 *  - **不进 session journal。** 学习事件是学习侧的可观察性，不是这一轮执行会话
 *    的事实。journal 记的是「用户这一轮发生了什么」，而板的观察是「学习机自己
 *    怎么了」；混进 journal 就等于让执行事实被学习污染（I3 的保守外推）。
 *    P01 控制板的 `board-events.ndjson` 是同构先例：一份属于子系统自己的追加日志。
 *  - **追加，且不阻塞用户任务。** 写失败吞掉、上报一行 warning 了事。学习侧失败
 *    只上报 `degraded`、不上抛（M2 §9）——一个写不进日志的板不该让用户的任务
 *    失败。
 *  - **目录惰性建。** 开关没开时这个 sink 根本不会被构造（见 `host.ts`），构造了
 *    也只有第一次真的 emit 才建目录——于是「开了学习但这一轮板一句话都没说」
 *    在磁盘上不留任何东西。
 */

/** 追加日志的文件名，学习根下唯一一份。 */
export const METHOD_EVENTS_FILE = "method-events.ndjson";

/**
 * 学习根：`tryloHome/learning`。
 *
 * 公式借用 `session-paths.ts::tryloHome`（唯一一份家目录），不在这里重拼——重拼
 * 一次就会出现第二个家，而 `TRYLO_HOME` 被设置的那天只有其中一个会跟着搬。
 */
export function methodLearningRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(tryloHome(homeDir, env), "learning");
}

/**
 * 档的根，与组合根（`integration/method/wiring.ts` 里 `methodPortOf` 用的那条）
 * 是同一个目录——`LA-RUN` 的端到端用「板真的把 `board-events.ndjson` 写在这个
 * 路径下」来证明两边没有漂。
 */
export function methodBoardRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(methodLearningRoot(homeDir, env), "board");
}

/**
 * 宿主交给组合根的那半个开关。
 *
 * 家目录不由宿主拼——`homeDir` + `env` 原样带过去，由本文件用 `tryloHome` 算，
 * 于是「家在哪」仍然只有一个公式。
 */
export type MethodLearningHost = {
  /** 缺席 = 不开：`wireMethodLearning` 会返回 `undefined`，连 `load()` 都不发生。 */
  readonly switch?: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * 把宿主的半个开关补成组合根要的整个 `learning`。
 *
 * sink 在这里造而不是在 `host.ts` 里一行行拼，是因为「事件日志落在学习根下」是
 * 落点自己的事；宿主只需要借出时钟和一句 warning 的去处。
 */
export function createMethodLearningWiring(
  host: MethodLearningHost,
  deps: MethodEventSinkDeps,
): MethodLearningInput {
  return {
    ...(host.switch === undefined ? {} : { switch: host.switch }),
    homeDir: host.homeDir,
    env: host.env,
    emit: createMethodEventSink(methodLearningRoot(host.homeDir, host.env), deps),
  };
}

export type MethodEventSinkDeps = {
  /** ISO-8601 时刻。与板共用调用方注入的时钟，所以测试钉住时钟就钉住了时间戳。 */
  readonly now: () => string;
  /** 写失败说给谁听。一行，且只说一次。 */
  readonly warn: (message: string) => void;
};

/**
 * 一个往 `root/method-events.ndjson` 追加的 sink。
 *
 * 每行一个 JSON 对象 `{ occurredAt, kind, payload }`——板的载荷是平的（板上报的
 * 是码与身份，从不报嵌套文档），所以这里不需要转译，直接一行一事件。
 */
export function createMethodEventSink(
  root: string,
  deps: MethodEventSinkDeps,
): MethodEventSink {
  const file = path.join(root, METHOD_EVENTS_FILE);
  let prepared = false;
  let warned = false;

  return (kind: string, payload: MethodEventPayload): void => {
    const line = `${JSON.stringify({ occurredAt: deps.now(), kind, payload })}\n`;
    try {
      if (!prepared) {
        mkdirSync(root, { recursive: true });
        prepared = true;
      }
      appendFileSync(file, line, "utf8");
    } catch (error) {
      // 目录可能是建好之后又被删掉的，所以下一次事件还会再试一次建目录。
      prepared = false;

      if (warned) {
        return;
      }

      warned = true;
      deps.warn(`method_event_sink_failed:${messageOf(error)}`);
    }
  };
}

/** 错误码优先：一个 EACCES 比一整段堆栈更适合出现在用户的一行 warning 里。 */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.message : "unknown";
}
