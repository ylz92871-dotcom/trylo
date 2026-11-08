import type { CentralDeliberationPort } from "../../learning/central/runtime/contracts.js";
import type { ProviderErrorClass, ProviderPort, ProviderRecoveryHint, ProviderUsage } from "../../ports/provider.js";
import type { LearningUsageBoundary } from "../../learning/control/usage-settlement.js";
import type { TimerScheduler } from "../../subagent/scheduler.js";
import type { CentralAccountingFundingPort } from "../learning-content/central-accounting-funding.js";
import type { CentralDeliberationReceiptsPort, CentralDeliberationReceiptFailure } from "./deliberation-receipts.js";
import { isCentralDeliberationOutputDiagnostics, isCompleteCentralOutputCapacityRejection,
  type CentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";
import { isCentralChangeReferenceRejection, type CentralChangeReferenceRejection } from "./change-reference-contract.js";
import { isCentralChangeStructureRejection, type CentralChangeStructureRejection } from "./change-structure-rejection.js";
import { isCentralCitationRejection, type CentralCitationRejection } from "../../learning/central/runtime/citation-rejection.js";
import type { CentralGenerationLimits } from "../../learning/central/runtime/generation.js";

export interface CentralModelDeliberationOptions {
  /** Unbilled single_request transport from the original credential owner. No business context/wrapper. */
  readonly provider: ProviderPort;
  readonly model: string;
  readonly funding: CentralAccountingFundingPort;
  readonly receipts?: CentralDeliberationReceiptsPort;
  readonly enabled?: () => boolean;
  readonly secrets?: readonly string[];
  /** Legacy setting: both generation default and ceiling. */
  readonly maxOutputTokens?: number;
  /** Explicit host generation policy; original per-thought and root funds still govern. */
  readonly generationLimits?: CentralGenerationLimits;
  /** Declared provider total-context ceiling; no output-policy or spending authority. */
  readonly contextWindow?: number;
  /** Omission chooses the single-action page on a JSON-capable connection.
   * Explicit json_object retains canonical v2; tool retains its old format.
   * The normal host selects action_tool for a tools-only connection.
   * Legacy JSON-schema mode remains unsupported. */
  readonly outputMode?: "structured" | "tool" | "json_object" | "action_json" | "action_tool";
  /** Explicit legacy total deadline. Omission uses bounded progress-aware streaming. */
  readonly timeoutMs?: number;
  readonly scheduler?: TimerScheduler;
}

export interface CentralDeliberationReceipt {
  readonly operationId: string;
  readonly reservationId: string;
  readonly maxTokens: number;
  readonly usage: ProviderUsage;
  readonly boundary: LearningUsageBoundary;
  readonly settlement: "confirmed" | "unconfirmed";
  readonly response: "accepted" | "rejected" | "unavailable";
  readonly reason?: string;
  /** Safe output/transport facts, never arguments or private reasoning. */
  readonly outputDiagnostics?: CentralDeliberationOutputDiagnostics;
  readonly semanticRejection?: CentralChangeReferenceRejection;
  /** Safe canonical shape/generation metadata; never a recovery grant. */
  readonly structureRejection?: CentralChangeStructureRejection;
  readonly citationRejection?: CentralCitationRejection;
}

export interface CentralModelDeliberation extends CentralDeliberationPort {
  /** Accounting identities only; never prompt bodies, credentials or hidden reasoning. */
  receipts(): readonly CentralDeliberationReceipt[];
}

/** Safe provider-owned refusal metadata; no diagnostic prose, headers or retry authorization. */
export interface CentralDeliberationProviderFailure {
  readonly class: ProviderErrorClass;
  readonly retryable: boolean;
  readonly recovery?: ProviderRecoveryHint;
}

/** These are unpaid local input-packing refusals. Each later request must pass
 * the real preflight; they are not evidence that the entire root lost funds. */
const INPUT_CAPACITY_REASONS = ["central_deliberation_context_capacity", "central_deliberation_new_source_context_capacity",
  "central_deliberation_publication_condition_context_capacity", "central_deliberation_provider_admission_context_capacity",
  "central_deliberation_capacity_increase_context_capacity"] as const;

export type CentralDeliberationInputCapacityReason = typeof INPUT_CAPACITY_REASONS[number];

export function isCentralDeliberationInputCapacity(reason: unknown): reason is CentralDeliberationInputCapacityReason {
  return typeof reason === "string" && INPUT_CAPACITY_REASONS.some(value => value === reason);
}

export class CentralDeliberationError extends Error {
  readonly failureClass: "resources" | "cancelled" | "duplicate" | "accounting" | "transport" | "contract";

  constructor(readonly reason: string, readonly delivery: "not_sent" | "unknown" | "returned" = "not_sent",
    readonly reservationId?: string, readonly providerFailure?: CentralDeliberationProviderFailure,
    readonly receiptFailure?: CentralDeliberationReceiptFailure, readonly outputDiagnostics?: CentralDeliberationOutputDiagnostics,
    readonly semanticRejection?: CentralChangeReferenceRejection,
    readonly structureRejection?: CentralChangeStructureRejection,
    readonly citationRejection?: CentralCitationRejection) {
    const details = receiptFailure === undefined ? "" : `;receipt_reason=${receiptFailure.reason}`
      + (receiptFailure.boardReason === undefined ? "" : `;board_reason=${receiptFailure.boardReason}`);

    super(reason + details);
    this.name = "CentralDeliberationError";

    if (outputDiagnostics !== undefined && !isCentralDeliberationOutputDiagnostics(outputDiagnostics)) {
      throw new CentralDeliberationError("central_deliberation_output_diagnostics_invalid", "returned", reservationId);
    }

    if (outputDiagnostics !== undefined) this.outputDiagnostics = Object.freeze({ ...outputDiagnostics });

    if (semanticRejection !== undefined) {
      if (!isCentralChangeReferenceRejection(semanticRejection)) {
        throw new CentralDeliberationError("central_deliberation_semantic_rejection_invalid", "returned", reservationId);
      }
      this.semanticRejection = Object.freeze({ ...semanticRejection, expected: Object.freeze([...semanticRejection.expected]) });
    }

    if (structureRejection !== undefined) {
      if (!isCentralChangeStructureRejection(structureRejection)) {
        throw new CentralDeliberationError("central_deliberation_structure_rejection_invalid", "returned", reservationId);
      }
      this.structureRejection = Object.freeze({ ...structureRejection });
    }

    if (citationRejection !== undefined) {
      if (!isCentralCitationRejection(citationRejection)) {
        throw new CentralDeliberationError("central_deliberation_citation_rejection_invalid", "returned", reservationId);
      }
      this.citationRejection = Object.freeze({ ...citationRejection });
    }

    this.failureClass = reason === "central_deliberation_incomplete" && delivery === "returned"
      && isCompleteCentralOutputCapacityRejection(outputDiagnostics) ? "resources"
      : /already_reserved/.test(reason) ? "duplicate" : /cancelled|collect_disabled/.test(reason) ? "cancelled"
      : reason === "learning_budget_stale" ? "accounting"
        : isCentralDeliberationInputCapacity(reason) ? "contract"
        : /budget|rate_limit|quota|resource|concurrency|context_capacity/.test(reason) ? "resources"
        : /settlement|accounting|board_unavailable|write_unconfirmed|reservation_unconfirmed|receipt_/.test(reason) ? "accounting"
          : /provider_(auth|invalid_request|protocol)$/.test(reason) ? "contract"
            : /provider_|transport|timeout|usage_absent|usage_tail|incomplete/.test(reason) ? "transport" : "contract";
  }
}

export const CENTRAL_DECISION_TOOL = "submit_central_deliberation";

export { CENTRAL_DEFAULT_OUTPUT_TOKENS } from "../../learning/central/runtime/generation.js";
