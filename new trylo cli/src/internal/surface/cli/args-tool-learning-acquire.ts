import { parseRun } from "./args-run.js";
import type { RunCommandOptions } from "./args-primitives.js";
import { isToolLearningJobId } from "../../learning/agent/subsystems/tool/domain/evolution/index.js";
import { isAcquisitionRecoveryReviewId } from "../../learning/agent/subsystems/tool/domain/evolution/acquisition-lease.js";
import { isAcquisitionInquiryReviewId } from "../../learning/agent/subsystems/tool/domain/evolution/acquisition-inquiry.js";

export type ToolLearningAcquireCommand = { readonly kind: "acquire-learning"; readonly jobId: string; readonly approvalId?: string; readonly run?: RunCommandOptions;
  readonly recovery?: { readonly childJobId: string; readonly attempt: number; readonly reviewId?: string };
  readonly resumeChildJobId?: string;
  readonly inquiry?: { readonly failureRef: string; readonly reviewId?: string; readonly recoveryReviewId?: string } };

export function parseToolLearningAcquire(tokens: readonly string[]): ToolLearningAcquireCommand | { readonly kind: "error"; readonly message: string } {
  const invalid = () => ({ kind: "error" as const, message: "acquire-learning needs jobId [--approve decisionVersionId] [--recover-child exactChild --attempt 1..3 [--confirm-recovery exactReview]] [--resume-child exactChild] [--reinvestigate-failure exactFailure [--confirm-inquiry exactReview | --confirm-inquiry-recovery exactReview]] [--provider id] [--model id] [--allow-tools run_shell]" });

  if (!isToolLearningJobId(tokens[0])) return invalid();

  let approvalId: string | undefined;
  let recoverChildJobId: string | undefined, resumeChildJobId: string | undefined, recoveryReviewId: string | undefined, recoveryAttempt: number | undefined;
  let failureRef: string | undefined, inquiryReviewId: string | undefined, inquiryRecoveryReviewId: string | undefined;
  const runTokens: string[] = [], seen = new Set<string>();

  for (let i = 1; i < tokens.length; i += 2) {
    const flag = tokens[i], value = tokens[i + 1];
    if (flag === undefined || value === undefined || value.startsWith("-") || seen.has(flag)) return invalid();

    seen.add(flag);

    if (flag === "--approve") approvalId = value;
    else if (flag === "--recover-child" || flag === "--resume-child") {
      if (!/^tool-adaptation_v1_[a-f0-9]{64}$/.test(value)) return invalid();
      if (flag === "--recover-child") recoverChildJobId = value; else resumeChildJobId = value;
    } else if (flag === "--attempt") {
      if (!/^[1-3]$/.test(value)) return invalid();
      recoveryAttempt = Number(value);
    } else if (flag === "--confirm-recovery") {
      if (!isAcquisitionRecoveryReviewId(value)) return invalid();
      recoveryReviewId = value;
    } else if (flag === "--reinvestigate-failure") {
      if (!/^tool-acquisition-failure_v1_[a-f0-9]{64}$/.test(value)) return invalid();
      failureRef = value;
    } else if (flag === "--confirm-inquiry" || flag === "--confirm-inquiry-recovery") {
      if (!isAcquisitionInquiryReviewId(value)) return invalid();
      if (flag === "--confirm-inquiry") inquiryReviewId = value; else inquiryRecoveryReviewId = value;
    }
    else if (["--provider", "--model", "--endpoint", "--allow-tools", "--deny-tools"].includes(flag)) runTokens.push(flag, value);
    else return invalid();
  }

  if ((recoverChildJobId !== undefined && (resumeChildJobId !== undefined || recoveryAttempt === undefined || runTokens.length > 0))
    || (recoverChildJobId === undefined && (recoveryAttempt !== undefined || recoveryReviewId !== undefined))
    || (recoveryReviewId !== undefined && approvalId === undefined) || (resumeChildJobId !== undefined && approvalId === undefined)) return invalid();

  if ((failureRef !== undefined && (recoverChildJobId !== undefined || resumeChildJobId !== undefined || recoveryAttempt !== undefined || recoveryReviewId !== undefined
      || seen.has("--allow-tools") || seen.has("--deny-tools")))
    || (failureRef === undefined && (inquiryReviewId !== undefined || inquiryRecoveryReviewId !== undefined))
    || ((inquiryReviewId !== undefined || inquiryRecoveryReviewId !== undefined) && approvalId === undefined)
    || (inquiryReviewId !== undefined && inquiryRecoveryReviewId !== undefined)
    || (failureRef !== undefined && inquiryReviewId === undefined && runTokens.length > 0)) return invalid();

  const run = runTokens.length === 0 ? undefined : parseRun([...runTokens, "tool-acquisition-adaptation"]);
  if (run !== undefined && run.kind !== "run") return invalid();

  return { kind: "acquire-learning", jobId: tokens[0]!, ...(approvalId === undefined ? {} : { approvalId }),
    ...(recoverChildJobId === undefined ? {} : { recovery: { childJobId: recoverChildJobId, attempt: recoveryAttempt!, ...(recoveryReviewId === undefined ? {} : { reviewId: recoveryReviewId }) } }),
    ...(resumeChildJobId === undefined ? {} : { resumeChildJobId }),
    ...(failureRef === undefined ? {} : { inquiry: { failureRef,
      ...(inquiryReviewId === undefined ? {} : { reviewId: inquiryReviewId }),
      ...(inquiryRecoveryReviewId === undefined ? {} : { recoveryReviewId: inquiryRecoveryReviewId }) } }),
    ...(run?.kind === "run" ? { run: run.options } : {}) };
}
