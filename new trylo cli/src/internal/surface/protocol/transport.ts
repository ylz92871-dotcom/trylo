import type {
  ReplayResult,
  TransportFrame,
  TransportListener,
  TransportPort,
  UnstampedFrame,
} from "../../ports/transport.js";
import { freezeJsonValue, type SurfaceFrame } from "./frames.js";

/**
 * `TransportPort` 的 in-process 实现：一段内存 log + 一组订阅者。
 *
 * 学 cline `hub/server/hub-event-log.ts` 的三件事（D5 §1.3、§9 第 2 条）：
 * 入 log 时盖全局单调序号、live 与 replay 复用同一批字节、断线用 cursor 追平。
 * 不学它的 SQLite 持久化——持久 log 属于 P04 压缩/检查点包，本包越界就是
 * 制造第二个事实源（WP §5 第 6 条明确禁止「顺便」做持久 log）。
 *
 * 几个刻意的取舍，都写在这里而不是藏在代码里：
 *
 * - **序号从 0 开始、无空洞**：`transportSequence = log.length`（append 前）。
 *   只有单线程同步 append 才会成立——本端口不接受并发写，也不假装接受。
 * - **已知帧的转换有唯一入口** {@link toUnstampedFrame}：端口自己不认识
 *   ACP/ag-ui（见 `ports/transport.ts` 的依赖方向说明），降级发生在边界上。
 * - **订阅者抛异常会向 `append` 传播**，且 log 已经写入、不回滚：
 *   队列里已有的事实就是事实，为了「好看」把它撤掉才是伪造。异常不被吞掉
 *   是仓库的既有纪律（禁止吞错）。
 * - **`replay` 不做上限截断**：log 规模由调用方自己管（测试夹具/会话级），
 *   本端口不发明分页大小这种策略。
 */
export function createInProcessTransport(): TransportPort {
  const log: TransportFrame[] = [];
  const listeners = new Set<TransportListener>();

  return {
    append(frame: UnstampedFrame): TransportFrame {
      const stamped = stamp(frame, log.length);
      log.push(stamped);
      for (const listener of [...listeners]) {
        listener(stamped);
      }
      return stamped;
    },

    subscribe(listener: TransportListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    replay(request): ReplayResult {
      if (!Number.isInteger(request.sinceSequence) || request.sinceSequence < -1) {
        return {
          ok: false,
          code: "invalid_cursor",
          detail: `sinceSequence 必须是 >= -1 的整数（-1 表示从头开始），收到 ${String(
            request.sinceSequence,
          )}`,
        };
      }
      return {
        ok: true,
        frames: log.filter((frame) => frame.transportSequence > request.sinceSequence),
        latestSequence: log.length - 1,
      };
    },

    latestSequence() {
      return log.length - 1;
    },
  };
}

/**
 * 帧类型 → 端口载荷。这是两个模块之间**唯一**的转换点：
 * `ports/**` 不知道 ACP/ag-ui，`surface/protocol/**` 不知道 log 的表示。
 */
export function toUnstampedFrame(frame: SurfaceFrame): UnstampedFrame {
  return {
    surface: frame.surface,
    body: frame.body,
    eventId: frame.source.eventId,
    sourceSequence: frame.source.sequence,
    kind: frame.source.kind,
  };
}

function stamp(frame: UnstampedFrame, transportSequence: number): TransportFrame {
  freezeJsonValue(frame.body);
  return Object.freeze({ ...frame, transportSequence });
}
