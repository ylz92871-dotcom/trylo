import type { ToolProductionPlan } from "../learning/domains/tool/evolution/production-plan.js";
import type { VerificationAuthorityReader, VerificationReceipt } from "../learning/verification-authority/contracts.js";
import type { ValidationRecord } from "../tooling/contract/types.js";
import type { JsonValue } from "../protocol/envelope.js";
import type { CandidateExecution } from "../learning/domains/tool/evolution/execution.js";
import type { NpmInstallPlan } from "../tooling/contract/npm-install.js";
import type { McpProtocolVersion } from "./mcp-client.js";

export type ToolProductionCheck =
  | { readonly kind: "verified"; readonly record: ValidationRecord; readonly receipt: VerificationReceipt }
  | { readonly kind: "failed" | "cancelled"; readonly record: ValidationRecord; readonly failure?: { readonly code: string; readonly message: string } };

/** The process root owns checking/signing. No caller can submit a verdict or a record to sign. */
export type ToolProductionPort = {
  readonly authority: VerificationAuthorityReader;
  readonly check: (plan: ToolProductionPlan, jobId: string, signal: AbortSignal) => Promise<ToolProductionCheck>;
  /** Optional for legacy embedded hosts; unsupported package profiles remain unavailable. */
  readonly execute?: (plan: ToolProductionPlan, input: JsonValue, signal: AbortSignal) => Promise<CandidateExecution>;
  readonly inspectInstallation?: (plan: NpmInstallPlan, bin: string, protocolVersion: McpProtocolVersion, signal: AbortSignal) => Promise<CandidateExecution>;
};
