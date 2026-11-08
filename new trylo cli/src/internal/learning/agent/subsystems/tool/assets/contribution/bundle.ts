import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../../../../../../tooling/approval/gates.js";
import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolPackageVersion } from "../../../../../../tooling/contract/types.js";
import { createSideEffectGuard, type SideEffectGuard } from "../../../../../../tooling/side-effects.js";

export type ContributionBundle = {
  readonly bundleId: string;
  readonly packageVersionId: string;
  readonly diff: string;
  readonly commitPlan: readonly string[];
  readonly tests: readonly string[];
  readonly changeSummary: string;
  readonly upstreamGuideChecklist: readonly string[];
  readonly licenseProvenance: string;
  readonly aiDisclosure: string;
  readonly suggestedPrompt: string;
  readonly sensitiveHits: readonly string[];
  readonly status: "prepared";
  readonly externalActions: readonly never[];
};

export type ContributionFailure =
  | ApprovalGateFailure
  | "not_optimized"
  | "sensitive_content"
  | "external_action_forbidden";

const SENSITIVE = [
  "BEGIN PRIVATE KEY",
  "AKIA",
  "D:\\CC\\trylo",
  "worktrees\\wp-p01-d",
  "/home/",
  "TRYLO_INTERNAL",
];

export function scanSensitive(text: string): readonly string[] {
  return SENSITIVE.filter((marker) => text.includes(marker));
}

export function prepareContributionBundle(input: {
  readonly pkg: ToolPackageVersion;
  readonly diff: string;
  readonly tests: readonly string[];
  readonly changeSummary: string;
}): Result<ContributionBundle, ContributionFailure> {
  if (input.pkg.origin !== "optimized") {
    return err("not_optimized", "contribution bundles are only for optimized upstream tools");
  }

  const combined = `${input.diff}\n${input.changeSummary}\n${input.tests.join("\n")}`;
  const sensitiveHits = scanSensitive(combined);
  if (sensitiveHits.length > 0) {
    return err("sensitive_content", `refusing bundle due to ${sensitiveHits.join(", ")}`);
  }

  return ok({
    bundleId: `bundle:${input.pkg.packageVersionId}`,
    packageVersionId: input.pkg.packageVersionId,
    diff: input.diff,
    commitPlan: [
      `record local commit for ${input.pkg.identity}@${input.pkg.version}`,
      "do not git push",
      "do not open pull request",
    ],
    tests: input.tests,
    changeSummary: input.changeSummary,
    upstreamGuideChecklist: [
      "read upstream contributing guide",
      "keep license and provenance",
      "disclose AI assistance",
      "do not include Trylo private paths",
    ],
    licenseProvenance: `${input.pkg.licenseSpdx} @ ${input.pkg.provenance.commit}`,
    aiDisclosure: "This change was drafted with AI assistance and requires human review before any upstream contact.",
    suggestedPrompt: `Propose a focused upstream patch for ${input.pkg.identity} preserving ${input.pkg.provenance.upstreamUrl}@${input.pkg.provenance.commit}.`,
    sensitiveHits: [],
    status: "prepared",
    externalActions: [],
  });
}

export async function executeContribution(
  approvalPort: ApprovalConsumptionPort | undefined,
  token: ApprovalGrantRef | undefined,
  now: string,
  candidateId: string,
  packageVersionId: string,
  scope: string,
  action: "push" | "issue" | "pull_request" | "contact_maintainer",
  guard: SideEffectGuard = createSideEffectGuard(),
): Promise<Result<{ readonly published: false }, ContributionFailure>> {
  const mapped =
    action === "push"
      ? "push"
      : action === "issue"
        ? "issue"
        : action === "pull_request"
          ? "pull_request"
          : "contact_maintainer";
  // Authorization first (audit P1-10): an unauthorized or port-less call must
  // not leave any trace on the guard — not even a denial attempt record.
  const gate = await consumeApproval(approvalPort, {
    action: "contribute",
    candidateId,
    packageVersionId,
    scope,
    now,
    ...(token === undefined ? {} : { token }),
  });
  if (!gate.ok) {
    return gate;
  }

  guard.deny(mapped);

  return err("external_action_forbidden", `${action} is not authorized in WP-P01-D`);
}
