import { sha256Hex, shortId } from "../shared/hash.js";
import type { OutcomeObservation } from "./contracts.js";

export const OUTCOME_EVENT_KINDS = ["feedback_text", "manual_edit", "rollback", "correction"] as const;

export type OutcomeEventKind = (typeof OUTCOME_EVENT_KINDS)[number];

export type OutcomeEvent = {
  readonly kind: OutcomeEventKind;
  readonly text?: string;
};

export type EvaluateOutcomeInput = {
  readonly commitmentIds: readonly string[];
  /** 本轮用户反馈事件（只含已发生的事实，不含任何推断）。 */
  readonly events: readonly OutcomeEvent[];
  /** 本轮任务终态：completed 只记"做完了"，永不记"偏好变强"。 */
  readonly taskOutcome?: "completed" | "failed" | "cancelled" | "exited";
  readonly traceId?: string;
  /** 历史 correction 指纹：命中即 repeated_correction。 */
  readonly priorCorrectionKeys?: ReadonlySet<string>;
  readonly now?: number;
};

export type EvaluateOutcomeResult = {
  readonly observations: readonly OutcomeObservation[];
  readonly pauseCommitmentIds: readonly string[];
};

const HELPFUL_MARK = /(?:这样|这么)(?:更好|很好|就对了)|以后(?:就)?这样|符合预期|正是我要的|保持这样/;
const UNHELPFUL_MARK = /不对|不是这样|恢复(?:以前|原来)|别再这样|这样不好|没帮助|反而更麻烦|撤销这个偏好/;

function correctionKeyFor(text: string): string | undefined {
  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 180);
  return normalized.length === 0 ? undefined : `ck_${sha256Hex(normalized).slice(0, 16)}`;
}

function signalFor(
  event: OutcomeEvent,
  priorKeys: ReadonlySet<string>,
): Pick<OutcomeObservation, "signal" | "attribution"> & { readonly correctionKey?: string } {
  const text = event.text ?? "";
  const key = correctionKeyFor(text);

  if (event.kind === "rollback") {
    return {
      signal: "rollback",
      attribution: "direct",
      ...(key === undefined ? {} : { correctionKey: key }),
    };
  }

  if (HELPFUL_MARK.test(text)) {
    return { signal: "explicit_helpful", attribution: "direct" };
  }

  if (UNHELPFUL_MARK.test(text)) {
    return { signal: "explicit_unhelpful", attribution: "direct" };
  }

  if (event.kind === "manual_edit") {
    return { signal: "material_rework", attribution: "partial" };
  }

  if (event.kind === "correction") {
    const key = correctionKeyFor(text);
    if (key !== undefined && priorKeys.has(key)) {
      return { signal: "repeated_correction", attribution: "direct", correctionKey: key };
    }

    return {
      signal: "material_rework",
      attribution: "partial",
      ...(key === undefined ? {} : { correctionKey: key }),
    };
  }

  return { signal: "material_rework", attribution: "partial" };
}

/**
 * 事后效果评估：只记录，不升不降。
 * - task_completed → attribution 永远 unknown：任务做完不能证明偏好变强。
 * - 没有明确反馈 → 不产 observation：效果保持 unknown，不许拿"没骂"当"叫好"。
 * - explicit_unhelpful / rollback → 建议暂停；repeated_correction 累计 ≥2 → 建议暂停。
 * 暂停只是"建议名单"，执行方另行决定；本模块不改任何承诺状态。
 */
export function evaluateOutcome(input: EvaluateOutcomeInput): EvaluateOutcomeResult {
  const now = input.now ?? Date.now();
  const observations: OutcomeObservation[] = [];
  const seenKeys = new Set<string>(input.priorCorrectionKeys ?? []);
  const repeatedCounts = new Map<string, number>();

  for (const commitmentId of input.commitmentIds) {
    for (const event of input.events) {
      if (event.kind === "feedback_text" && !HELPFUL_MARK.test(event.text ?? "") && !UNHELPFUL_MARK.test(event.text ?? "")) {
        continue;
      }

      const mapped = signalFor(event, seenKeys);
      if (mapped.correctionKey !== undefined) {
        seenKeys.add(mapped.correctionKey);
        if (mapped.signal === "repeated_correction") {
          repeatedCounts.set(commitmentId, (repeatedCounts.get(commitmentId) ?? 0) + 1);
        }
      }

      observations.push({
        id: shortId("outcome", [commitmentId, mapped.signal, String(now)]),
        commitmentId,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        signal: mapped.signal,
        attribution: mapped.attribution,
        createdAt: now,
      });
    }
    if (input.taskOutcome === "completed") {
      observations.push({
        id: shortId("outcome", [commitmentId, "task_completed", String(now)]),
        commitmentId,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        signal: "task_completed",
        attribution: "unknown",
        createdAt: now,
      });
    }
  }

  const pauseCommitmentIds = input.commitmentIds.filter((commitmentId) => {
    const relevant = observations.filter((item) => item.commitmentId === commitmentId);
    if (relevant.some((item) => item.signal === "explicit_unhelpful" || item.signal === "rollback")) {
      return true;
    }

    // 跨批累计由接线方把历史 repeated key 喂给 priorCorrectionKeys；
    // 本批内出现 ≥2 次重复纠正即建议暂停。
    return (repeatedCounts.get(commitmentId) ?? 0) >= 2;
  });

  return { observations, pauseCommitmentIds };
}
