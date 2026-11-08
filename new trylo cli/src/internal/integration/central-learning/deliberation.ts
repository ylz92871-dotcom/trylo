import type { CentralDeliberationDeliveryConstraints, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { ProviderRequest } from "../../ports/provider.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { learningUsageSettlement } from "../../learning/control/usage-settlement.js";
import { text } from "../../validation/json-shape.js";
import { CentralDeliberationError, type CentralDeliberationReceipt,
  type CentralModelDeliberation, type CentralModelDeliberationOptions } from "./deliberation-contract.js";
import { centralDeliberationReservation, decodeCentralDeliberation, validateCentralDeliberationRequest,
  validateCentralDeliberationSources } from "./deliberation-prompt.js";
import { CENTRAL_ACTION_JSON_FORMAT, CENTRAL_ACTION_TOOL_FORMAT, CENTRAL_CHANGE_TOOL_FORMAT,
  centralDecisionWireFields, compileCentralDecision, encodeCentralDeliberation } from "./deliberation-encoding.js";
import { readCentralDeliberationStream } from "./deliberation-stream.js";
import { packCentralDeliberationContext } from "./deliberation-context.js";
import { createCentralDeliberationWireEvidence, readCentralDeliberationReceiptFailure } from "./deliberation-receipts.js";
import { assertCentralActionCorrectionDelivery } from "./runtime-action-correction.js";
import { centralGenerationLimits, centralThinkOutputTokens } from "./deliberation-generation.js";
import { selectCentralAutomaticOutput } from "./deliberation-output-investment.js";

export { CentralDeliberationError } from "./deliberation-contract.js";
export type { CentralModelDeliberationOptions, CentralDeliberationReceipt, CentralModelDeliberation } from "./deliberation-contract.js";

/** Independent semantic computation over the public checkpoint; the domain driver owns the actual loop. */
export function createCentralModelDeliberation(options: CentralModelDeliberationOptions): CentralModelDeliberation {
  const timeoutMs = options.timeoutMs, generationLimits = centralGenerationLimits(options.maxOutputTokens, options.generationLimits);
  const outputMode = options.outputMode ?? (options.provider.responseFormats?.includes("json_object") ? "action_json" : "tool");
  if (!text(options.model, 512) || !["tool", "json_object", "action_json", "action_tool"].includes(outputMode)
    || options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow < 1 || options.contextWindow > 1_000_000_000)
    || timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)) {
    throw new CentralDeliberationError("central_deliberation_options_invalid");
  }

  const enabled = options.enabled ?? (() => true), secrets = options.secrets ?? [];
  // Empty fork prohibits borrowing task-native continuation. Persistent continuation is request.state only.
  const provider = options.provider.fork?.([]);
  if (provider === undefined || provider === options.provider) throw new CentralDeliberationError("central_deliberation_isolation_unavailable");

  if ((outputMode === "json_object" || outputMode === "action_json") && !provider.responseFormats?.includes("json_object")) {
    throw new CentralDeliberationError("central_deliberation_output_capability_unavailable");
  }

  const wireFormat = outputMode === "action_tool" ? CENTRAL_ACTION_TOOL_FORMAT : outputMode === "action_json" ? CENTRAL_ACTION_JSON_FORMAT
    : outputMode === "json_object" ? { kind: "json_object" as const } : CENTRAL_CHANGE_TOOL_FORMAT;
  const receipts: CentralDeliberationReceipt[] = [];
  const inFlight = new Set<string>();
  const resourceMessage = (projection: CentralBudgetProjection, reservationId: string, maxTokens: number) => ({ role: "user" as const,
    content: canonicalJson({ role: "host_original_root_after_this_computation_reservation", budgetId: projection.budget.budgetId,
      limits: projection.budget.limits, occupied: projection.occupied, available: projection.available,
      status: projection.status, holdReason: projection.holdReason ?? null,
      thisComputation: { reservationId, maxTokens, calls: 1, steps: 1 },
      interpretation: "current_root_resources_not_new_authorization_or_value_prediction" }) });

  async function originalProjection(signal: AbortSignal) {
    if (signal.aborted || !enabled()) throw new CentralDeliberationError("central_deliberation_cancelled");

    try { await options.receipts?.assertWritable?.(signal); }
    catch (error) { throw new CentralDeliberationError("central_deliberation_response_write_unconfirmed", "not_sent", undefined,
      undefined, readCentralDeliberationReceiptFailure(error)); }

    const current = await options.funding.inspect();
    if (!current.ok) throw new CentralDeliberationError(current.reason);

    return current.projection;
  }

  function prepareFromProjection(request: CentralDeliberationRequest, projection: CentralBudgetProjection,
    constraints?: CentralDeliberationDeliveryConstraints) {
    if (projection.budget.scope !== request.scope || projection.budget.budgetId !== request.budgetId) throw new CentralDeliberationError("central_deliberation_funding_mismatch");

    const reservationId = centralDeliberationReservation(request);
    if (projection.budget.accounting?.some(row => row.reservationId === reservationId)) throw new CentralDeliberationError("central_deliberation_already_reserved", "unknown", reservationId);

    // Validate the original public input before projecting its visible bodies.
    validateCentralDeliberationSources(request, secrets);
    const outputLimit = centralThinkOutputTokens(request, generationLimits);
    // Quote the complete wire with a resource envelope whose numeric fields dominate
    // every legal root projection. After reservation only this envelope is replaced.
    const ceiling = { tokens: 1_000_000_000, calls: 1_000_000_000, steps: 1_000_000_000 };
    const quoteProjection = { ...projection, occupied: ceiling, available: ceiling, status: "exhausted" as const };

    if (projection.status !== "available" || projection.available.calls < 1 || projection.available.steps < 1) {
      throw new CentralDeliberationError("central_deliberation_budget_exhausted");
    }

    const project = (candidate: CentralDeliberationRequest) => constraints?.projectJudgmentContext?.(candidate) ?? candidate;
    const quote = (candidate: CentralDeliberationRequest) => {
      candidate = project(candidate);
      const input = encodeCentralDeliberation(candidate, wireFormat, secrets), checkpoint = input.messages;

      assertCentralActionCorrectionDelivery(candidate, input.version,
        "referenceSelectionContractRef" in input.dictionary ? input.dictionary.referenceSelectionContractRef : undefined);
      const messages = [...checkpoint, resourceMessage(quoteProjection, reservationId, 1_000_000_000)];
      const prompt = canonicalJson(centralDecisionWireFields({ ...input.wire, messages }));
      const overhead = provider!.continuation?.estimateOverheadTokens?.(messages) ?? 0;
      if (!Number.isSafeInteger(overhead) || overhead < 0) throw new CentralDeliberationError("central_deliberation_overhead_invalid");

      const quotedBytes = new TextEncoder().encode(prompt).length;

      return { checkpoint, messages, wire: input.wire, prompt, dictionary: input.dictionary, quotedBytes, maxTokens: quotedBytes + 512 + overhead + outputLimit };
    };

    request = packCentralDeliberationContext(request, candidate => {
      const measured = quote(candidate);
      return measured.prompt.length <= request.configuration.allowance.maxPromptChars
        && measured.maxTokens <= Math.min(projection.available.tokens,
          request.configuration.thoughtMaxTokens ?? request.configuration.allowance.maxTokens, options.contextWindow ?? 1_000_000_000)
        && (constraints === undefined || constraints.sourceProgressFits(project(candidate), "packing"));
    });
    request = project(request);
    validateCentralDeliberationRequest(request, secrets);

    if (constraints !== undefined && !constraints.sourceProgressFits(request, "admission")) {
      throw new CentralDeliberationError("central_deliberation_context_capacity");
    }

    const measured = quote(request);
    const call: ProviderRequest = { ...measured.wire, attemptId: reservationId, model: options.model, messages: measured.messages, maxOutputTokens: outputLimit };

    return { request, reservationId, maxTokens: measured.maxTokens, call, checkpoint: measured.checkpoint,
      dictionary: measured.dictionary, quotedBytes: measured.quotedBytes };
  }

  async function prepare(request: CentralDeliberationRequest, signal: AbortSignal, constraints?: CentralDeliberationDeliveryConstraints) {
    return prepareFromProjection(request, await originalProjection(signal), constraints);
  }

  return Object.freeze({
    receipts: () => Object.freeze(receipts.map(receipt => Object.freeze({ ...receipt, usage: Object.freeze({ ...receipt.usage }), boundary: Object.freeze({ ...receipt.boundary }),
      ...(receipt.outputDiagnostics === undefined ? {} : { outputDiagnostics: Object.freeze({ ...receipt.outputDiagnostics }) }),
      ...(receipt.semanticRejection === undefined ? {} : { semanticRejection: Object.freeze({ ...receipt.semanticRejection,
        expected: Object.freeze([...receipt.semanticRejection.expected]) }) }),
      ...(receipt.structureRejection === undefined ? {} : { structureRejection: Object.freeze({ ...receipt.structureRejection }) }),
      ...(receipt.citationRejection === undefined ? {} : { citationRejection: Object.freeze({ ...receipt.citationRejection }) }) }))),

    async selectAutomaticOutput(request: CentralDeliberationRequest, signal: AbortSignal, constraints?: CentralDeliberationDeliveryConstraints) {
      const projection = await originalProjection(signal);
      return selectCentralAutomaticOutput(request, centralThinkOutputTokens(request, generationLimits),
        candidate => { prepareFromProjection(candidate, projection, constraints); });
    },

    async prepareDelivery(request: CentralDeliberationRequest, signal: AbortSignal, constraints?: CentralDeliberationDeliveryConstraints) {
      return (await prepare(request, signal, constraints)).request;
    },

    async inspect(input: { readonly scope: string; readonly budgetId: string; readonly operationId: string }, signal: AbortSignal) {
      if (signal.aborted) throw new CentralDeliberationError("central_deliberation_cancelled");

      const delivery = await options.receipts?.read(input.operationId, signal);
      if (delivery !== undefined) {
        if (delivery.request.scope !== input.scope || delivery.request.budgetId !== input.budgetId) throw new CentralDeliberationError("central_deliberation_receipt_mismatch");
        return { status: "returned" as const, ...delivery };
      }

      const current = await options.funding.inspect();
      if (!current.ok) throw new CentralDeliberationError(current.reason);

      if (current.projection.budget.scope !== input.scope || current.projection.budget.budgetId !== input.budgetId) throw new CentralDeliberationError("central_deliberation_funding_mismatch");

      const reservationId = centralDeliberationReservation(input);
      if (inFlight.has(reservationId) || current.projection.budget.accounting?.some(row => row.reservationId === reservationId)) {
        return { status: "unknown" as const, sourceRefs: [reservationId] };
      }

      const root = current.projection.budget;

      return { status: "not_sent" as const, sourceRefs: [reservationId],
        ...(current.owner.kind !== "central_deliberation" ? {} : { admission: { scope: input.scope, operationId: input.operationId,
          reservationId, rootRef: { budgetId: root.budgetId, scope: root.scope, openedSequence: root.openedSequence,
            authorizationRef: root.authorizationRef }, ownerId: current.owner.ownerId, boardSequence: current.boardSequence } }) };
    },

    async deliberate(request: CentralDeliberationRequest, signal: AbortSignal, constraints?: CentralDeliberationDeliveryConstraints) {
      const reservationId = centralDeliberationReservation(request);
      if (inFlight.has(reservationId)) throw new CentralDeliberationError("central_deliberation_already_reserved", "unknown", reservationId);

      inFlight.add(reservationId);

      try {
      const call = await prepare(request, signal, constraints);

      request = call.request;

      if (signal.aborted || !enabled()) throw new CentralDeliberationError("central_deliberation_cancelled");

      let reservation;

      try { reservation = await options.funding.reserve({ reservationId: call.reservationId, maxTokens: call.maxTokens }); }
      catch { throw new CentralDeliberationError("central_deliberation_reservation_unconfirmed", "not_sent", call.reservationId); }

      if (!reservation.ok) throw new CentralDeliberationError(reservation.reason, "not_sent", call.reservationId);

      if (reservation.status !== "reserved") throw new CentralDeliberationError("central_deliberation_already_reserved", "unknown", call.reservationId);

      const finalCall = { ...call.call, messages: [...call.checkpoint, resourceMessage(reservation.projection, call.reservationId, call.maxTokens)] };
      const finalPrompt = canonicalJson(centralDecisionWireFields(finalCall));
      if (finalPrompt.length > request.configuration.allowance.maxPromptChars || new TextEncoder().encode(finalPrompt).length > call.quotedBytes) {
        // No transport was invoked; zero usage is a known local fact, not a remote timeout refund.
        const zero = await options.funding.settle({ reservationId: call.reservationId, usage: { kind: "reported", totalTokens: 0, model: options.model } });
        throw new CentralDeliberationError(zero.ok ? "central_deliberation_quote_mismatch" : zero.reason, "not_sent", call.reservationId);
      }

      const response = await readCentralDeliberationStream({ provider, request: finalCall, signal, enabled, maxTokens: call.maxTokens,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }) });
      let decoded, semanticRejection, structureRejection, citationRejection, reason = response.reason ?? (response.boundary.kind === "unknown" ? response.boundary.reason : undefined);
      if (reason === undefined) {
        try {
          decoded = decodeCentralDeliberation(compileCentralDecision(response.output, request, call.dictionary, wireFormat), request, secrets);
        }
        catch (error) {
          reason = error instanceof CentralDeliberationError ? error.reason : "central_deliberation_output_invalid";
          if (error instanceof CentralDeliberationError) {
            semanticRejection = error.semanticRejection;
            structureRejection = error.structureRejection;
            citationRejection = error.citationRejection;
          }
        }
      }

      const receipt = { operationId: request.operation.operationId, reservationId: call.reservationId, maxTokens: call.maxTokens,
        usage: response.usage, boundary: response.boundary, response: decoded !== undefined ? "accepted" as const
          : response.boundary.kind === "complete" ? "rejected" as const : "unavailable" as const,
        ...(response.diagnostics === undefined ? {} : { outputDiagnostics: response.diagnostics }),
        ...(semanticRejection === undefined ? {} : { semanticRejection }),
        ...(structureRejection === undefined ? {} : { structureRejection }),
        ...(citationRejection === undefined ? {} : { citationRejection }),
        ...(reason === undefined ? {} : { reason }) };
      let settlement;

      try { settlement = await options.funding.settle({ reservationId: call.reservationId,
        usage: learningUsageSettlement(response.boundary, response.reported ? { totalTokens: response.usage.totalTokens,
          inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, model: options.model } : undefined) }); }
      catch {
        settlement = { ok: false as const, reason: "central_deliberation_settlement_unconfirmed" };
      }

      receipts.push({ ...receipt, settlement: settlement.ok ? "confirmed" : "unconfirmed" });

      // A real returned semantic result remains recoverable even when billing acknowledgement is lost.
      // Its original reservation stays conservative; replaying the receipt never refunds it or resends.
      if (decoded !== undefined && options.receipts !== undefined) {
        try { await options.receipts.save({ request, output: decoded, wireEvidence: createCentralDeliberationWireEvidence({
          request, output: decoded, rawChange: response.output, wire: finalCall,
          ...(wireFormat.kind === "action_json" || wireFormat.kind === "action_tool" ? { format: wireFormat } : {}) }, secrets) }, signal); }
        catch (error) { throw new CentralDeliberationError("central_deliberation_response_write_unconfirmed", "unknown", call.reservationId,
          undefined, readCentralDeliberationReceiptFailure(error)); }
      }

      if (!settlement.ok) throw new CentralDeliberationError(settlement.reason, "unknown", call.reservationId,
        response.providerFailure, undefined, response.diagnostics, semanticRejection, structureRejection, citationRejection);

      if (decoded === undefined) throw new CentralDeliberationError(reason ?? "central_deliberation_output_invalid", response.boundary.kind === "complete" ? "returned" : "unknown",
        call.reservationId, response.providerFailure, undefined, response.diagnostics, semanticRejection, structureRejection, citationRejection);

      return decoded;
      } finally { inFlight.delete(reservationId); }
    },
  });
}
