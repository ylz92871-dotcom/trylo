import type { Result } from "../../../../../../../tooling/contract/result.js";
import type { Platform } from "../allowlist.js";
import type { AcquisitionFailure } from "../guarded-get.js";

/**
 * 一个平台适配器的形状（P05 工具学习规格 §3）。
 *
 * 六个方法，三对：**拼 URL** 与 **读 JSON**。没有「取字节」——取字节是
 * `guardedGet` 的事，而那是唯一查白名单的地方。分开的理由很实际：适配器要改的
 * 只是 URL 与字段名，闸门一个都不该跟着动；闸门要改的时候，四个平台也不该各改
 * 一遍。
 *
 * 适配器不认识 `ToolCandidate`（那是 P01 WP-D 的评估对象），也不判断许可证是否
 * 可接受。它只回答「这个平台怎么问、答回来的东西长什么样」，剩下的判断留给
 * 既有的评估与 vetting——这一层一个新政策都不该有。
 */

/** 指向平台上某个东西的最小坐标。`version` 缺席表示「最新」。 */
export type CandidateRef = {
  readonly platform: Platform;
  readonly id: string;
  readonly version?: string;
};

export type CandidateMetadata = {
  readonly ref: CandidateRef;
  /** 平台上的页面地址。 */
  readonly sourceUrl: string;
  /** 上游仓库地址。域名锚定已经核过一遍。 */
  readonly upstreamUrl: string;
  /** 平台自报的 SPDX；读不出来是 `UNKNOWN`，不是编一个。 */
  readonly licenseSpdx: string;
  /**
   * 身份判定。
   *
   * 只有**平台自己的信号**能把它抬到 `official`（例如 GitHub 说这是组织账号且
   * 不是 fork）；读不出信号就是 `unverified`。适配器从不因为「名字看着像官方」
   * 就抬高它——冒充正是这么发生的。
   */
  readonly officialIdentity: "official" | "unverified" | "impersonation_risk";
};

export type PlatformAdapter = {
  readonly platform: Platform;
  readonly searchUrl: (capability: string) => Result<string, AcquisitionFailure>;
  readonly metadataUrl: (ref: CandidateRef) => Result<string, AcquisitionFailure>;
  readonly archiveUrl: (ref: CandidateRef) => Result<string, AcquisitionFailure>;
  readonly readSearch: (payload: unknown) => Result<readonly CandidateRef[], AcquisitionFailure>;
  readonly readMetadata: (
    ref: CandidateRef,
    payload: unknown,
  ) => Result<CandidateMetadata, AcquisitionFailure>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读一个非空字符串字段；别的一律当没读到。 */
export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
