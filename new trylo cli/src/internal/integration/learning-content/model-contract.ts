import type { ProviderMessage, ProviderPort, ProviderUsage } from "../../ports/provider.js";
import type { CentralFundingPort } from "../../learning/agent/subsystems/collaboration/index.js";
import type { LearningUsageBoundary } from "../../learning/control/usage-settlement.js";
import type { ContentSemanticPort, ContentSemanticRequest } from "../../learning/central/content/process-contract.js";
import type { TimerScheduler } from "../../subagent/scheduler.js";

export interface ContentSemanticModelOptions {
  /** Host builds this with the existing single_request transport policy. This must
   * be the unbilled transport, not an existing subsystem's funding wrapper: this adapter owns each reservation. */
  readonly provider: ProviderPort;
  readonly model: string;
  readonly funding: CentralFundingPort;
  readonly jobId: string;
  readonly grantId: string;
  readonly claimId: string;
  /** Host-approved background only; citations still bind packet.records, never this context. */
  readonly contextMessages?: readonly Pick<ProviderMessage, "role" | "content">[];
  readonly enabled?: () => boolean;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly scheduler?: TimerScheduler;
}

export interface ContentModelReceipt {
  readonly stage: ContentSemanticRequest["stage"];
  readonly inputHash: string;
  readonly reservationId: string;
  readonly grantId: string;
  readonly claimId: string;
  readonly maxTokens: number;
  readonly usage: ProviderUsage;
  readonly boundary: LearningUsageBoundary;
  readonly settlement: "confirmed" | "unconfirmed";
  readonly response: "accepted" | "rejected" | "unavailable";
  readonly reason?: string;
}

export interface ContentSemanticModel extends ContentSemanticPort {
  /** Accounting/source identities only. No prompts, credentials or hidden reasoning. */
  receipts(): readonly ContentModelReceipt[];
}

export class ContentModelError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ContentModelError";
  }
}
