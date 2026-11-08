import { isSubagentObservation } from "../../../../../protocol/subagent-observation.js";

export type ObjectiveMemberReport = {
  readonly attribution: "member_claim";
  readonly reportId?: string;
  readonly reportState: "progress" | "blocked" | "ready";
  readonly reportExcerpt: string;
  readonly reportTextTruncated: boolean;
};

/** Ordinary authored progress can inform PA without becoming a verified fact or automatically opening an issue. */
export function objectiveMemberReport(value: unknown): ObjectiveMemberReport | undefined {
  if (!isSubagentObservation(value) || value.kind !== "report" || value.text === undefined
    || value.reportState !== "progress" && value.reportState !== "blocked" && value.reportState !== "ready") return undefined;
  return { attribution: "member_claim", ...(value.id.length > 512 ? {} : { reportId: value.id }),
    reportState: value.reportState, reportExcerpt: value.text.slice(0, 240), reportTextTruncated: value.text.length > 240 };
}
