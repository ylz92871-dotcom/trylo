import { hookLabelsFor } from "./board-ledger.js";
import { compileSlot, methodRefOf, type CompiledSlot } from "./compile.js";
import { methodMessage, type FieldedHint, type MethodRequest, type MethodSlotDelivery } from "../port.js";
import type { BoardState } from "./board.js";
import { METHOD_CONTEXT_TOOL } from "../experience-port.js";

export function intentOn(state: BoardState, turnId: string, beat: number): boolean {
  return state.turnId === turnId && state.intentBeat === beat;
}

/** All requests use the latest canonical archive read by the same planning hook. */
export async function requestSlotFor(state: BoardState, request: MethodRequest): Promise<MethodSlotDelivery | undefined> {
  await state.load;
  const runtime = state.options.experience;
  const refreshed = await runtime?.slot(request.turnId, request.toolNames, request.retrievalCue, request.retrievalSequence,
    request.requestBoundarySequence, request.previousExecutionSpan);
  const experience = request.toolNames.includes(METHOD_CONTEXT_TOOL) ? refreshed : undefined;

  if (runtime !== undefined) state.archive = runtime.legacyArchive();

  const intent = intentOn(state, request.turnId, request.beat);

  if (runtime !== undefined && !runtime.allowLegacy(request.turnId)) {
    const bound = boundSlot(state, experience, intent);
    return deliver(state, request, bound.delivery, bound.intent);
  }

  const compiled = compileSlot({ archive: state.archive.filter(item => runtime?.legacyEligible?.(item.versionId) ?? true), toolNames: request.toolNames,
    currentFamily: state.unresolvedFamily, hookLabels: hookLabelsFor(state, request.beat),
    slotChars: state.grant.slotChars, slotCards: state.grant.slotCards });
  let fielded = fieldedHintsOf(compiled);
  const limit = runtime === undefined ? Infinity : state.grant.slotChars;
  let legacy = methodMessage({ fielded, intent, vocabulary: state.vocabulary });

  while (fielded.length > 0 && (experience?.message.content.length ?? 0) + (legacy?.message.content.length ?? 0) > limit) {
    fielded = fielded.slice(0, -1);
    legacy = methodMessage({ fielded, intent, vocabulary: state.vocabulary });
  }

  if (legacy === undefined) return deliver(state, request, experience, false);

  if (experience === undefined || legacy.message.content.length + experience.message.content.length + 1 > limit) {
    return deliver(state, request, legacy.message.content.length <= limit ? legacy : experience, intent && legacy.message.content.length <= limit);
  }

  return deliver(state, request, { message: { role: "system", content: experience.message.content + "\n" + legacy.message.content },
    receipts: legacy.receipts }, intent);
}

function boundSlot(state: BoardState, experience: MethodSlotDelivery | undefined, intent: boolean) {
  if (experience === undefined || !intent) return { delivery: experience, intent: false };
  const extra = methodMessage({ fielded: [], intent: true, vocabulary: state.vocabulary });
  if (extra === undefined) return { delivery: experience, intent: false };
  const content = experience.message.content + "\n" + extra.message.content;
  if (content.length <= state.grant.slotChars) return { delivery: { ...experience, message: { role: "system" as const, content } }, intent: true };
  return extra.message.content.length <= state.grant.slotChars ? { delivery: extra, intent: true } : { delivery: experience, intent: false };
}

function deliver(state: BoardState, request: MethodRequest, delivery: MethodSlotDelivery | undefined, requested: boolean) {
  // Confirmation controls the existing stripper. A dropped budget segment must
  // not leave a receiver armed for an instruction the model never received.
  state.intentDelivery = requested && delivery !== undefined ?
    { turnId: request.turnId, beat: request.beat } : undefined;
  return delivery;
}

function fieldedHintsOf(compiled: CompiledSlot): readonly FieldedHint[] {
  return compiled.variants.map((variant, index) => ({ receipt: { ref: methodRefOf(index), versionId: variant.versionId,
    proposalId: variant.proposalId, nicheId: variant.nicheId }, hint: compiled.hints[index] ?? variant.card.hint }));
}
