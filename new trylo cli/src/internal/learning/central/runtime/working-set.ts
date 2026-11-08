import { canonicalJson, contentHashOf } from "../../control/hash.js";
import type { CentralCompletedOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "./contracts.js";
import { canonicalReadAddress } from "./read-failure.js";
import { isCentralUnreadNavigationMaterial } from "./material-role.js";
import { CENTRAL_PROVIDER_WAIT_PREFIX, CENTRAL_RESOURCE_WAIT_PREFIX, isLocalResourceWait, isProviderResourceWait } from "./resource-waits.js";
import { CENTRAL_RUNTIME_LIMITS } from "./validation.js";

/** Read names and prose cannot turn the same original target/results into a
 * second paid review. A genuinely different result reference remains distinct. */
export function centralAgendaReadReviewId(scope: string, completedRead: CentralCompletedOperation): string {
  if (completedRead.operation.kind !== "read") throw new Error("central_agenda_read_required");
  const targets = [...new Set(completedRead.operation.refs.map(canonicalReadAddress))].sort();
  return `central-agenda-read-review:${contentHashOf([scope, targets, [...completedRead.resultRefs].sort()])}`;
}

function reviewsAgendaRead(scope: string, read: CentralCompletedOperation, review: CentralCompletedOperation): boolean {
  return review.intentId === "central:agenda" && review.operation.kind === "think"
    && (review.operation.operationId === centralAgendaReadReviewId(scope, read)
      || review.operation.sourceRefs.includes(read.operation.operationId)
        && read.resultRefs.every(ref => review.operation.sourceRefs.includes(ref)));
}

/** A returned read opens one result-bound agenda review. An already issued
 * review, including a failed/unknown one, never becomes another paid trigger. */
export function unreviewedCentralAgendaReads(state: CentralLearningRuntimeState): readonly CentralCompletedOperation[] {
  return state.completed.filter(row => row.intentId === "central:agenda" && row.operation.kind === "read"
    && row.outcome === "returned" && row.resultRefs.length > 0
    && !state.completed.some(review => reviewsAgendaRead(state.scope, row, review)));
}

/** Retain an already advertised page locator, including nonzero offsets. This
 * recognizes navigation for compaction only; it supplies no read authority or
 * body evidence and never decodes the original source. */
function advertisesAgendaRead(material: CentralRuntimeMaterial, targets: ReadonlySet<string>): boolean {
  if (!isCentralUnreadNavigationMaterial(material)) return false;

  let value: unknown;

  try { value = JSON.parse(material.text); }
  catch { return false; } // Unstructured navigation contains no typed readRef.

  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "role" in value && typeof value.role === "string" && "readRef" in value && typeof value.readRef === "string"
    && targets.has(canonicalReadAddress(value.readRef));
}

/** Only previously persisted history leaves working memory. Original Board
 * records and receipt indexes remain authoritative for replay and exact recall. */
export function compactCentralWorkingSet(previous: CentralLearningRuntimeState, next: CentralLearningRuntimeState,
  knownConsumed: readonly string[] = previous.consumedSourceRefs,
  archivedMaterialRefs: readonly string[] = []): CentralLearningRuntimeState {
  const oldCompleted = new Set(previous.completed.map(row => canonicalJson(row)));
  // A body restored from verified lifetime history is already durable even
  // when it was absent from the immediately preceding working-memory window.
  const oldMaterials = new Set([...previous.materials.map(row => row.ref), ...archivedMaterialRefs]);
  const archivedSources = new Set(archivedMaterialRefs);
  const oldEnded = new Set(previous.intents.filter(row => row.continuation.kind === "ended").map(row => row.intentId));
  const known = new Set(knownConsumed), freshConsumed = next.consumedSourceRefs.filter(ref => !known.has(ref));
  const oldCursorRoom = Math.max(0, Math.min(64, CENTRAL_RUNTIME_LIMITS.references - freshConsumed.length));
  const oldCursor = next.consumedSourceRefs.filter(ref => known.has(ref));
  const recentOperations = new Set(next.completed.slice(-16).map(row => row.operation.operationId));
  const recentMaterials = new Set(next.materials.slice(-8).map(row => row.ref));
  const unreadAgendaResults = unreviewedCentralAgendaReads(next);
  const agendaReadOperations = new Set(unreadAgendaResults.map(row => row.operation.operationId));
  const agendaReadRefs = new Set([
    ...(next.agendaRead === undefined ? [] : [next.agendaRead.operationId, ...next.agendaRead.refs, ...next.agendaRead.sourceRefs]),
    ...unreadAgendaResults.flatMap(row => [row.operation.operationId, ...row.operation.sourceRefs, ...row.resultRefs,
      ...(row.operation.kind === "read" ? row.operation.refs : [])]),
  ].flatMap(ref => [ref, canonicalReadAddress(ref)]));
  const agendaNavigationRefs = new Set(agendaReadRefs.size === 0 ? []
    : next.materials.filter(row => advertisesAgendaRead(row, agendaReadRefs)).map(row => row.ref));
  const activeWaits = new Set(next.intents.flatMap(row => row.continuation.kind === "waiting" ? row.continuation.wait.sourceRefs : []));
  // A domain budget return cannot erase a concurrent provider deadline. Keep
  // only the newest condition of each kind and their original purposes.
  const reversed = [...next.materials].reverse();
  const resourceWaitRefs = new Set([reversed.find(isLocalResourceWait), reversed.find(isProviderResourceWait)]
    .flatMap(row => row === undefined ? [] : [row.ref, ...row.sourceRefs]));
  // Original receipts must remain recoverable without a semantic wait pin.
  const unknown = new Set(next.completed.filter(row => row.outcome === "unknown" && row.operation.kind === "think")
    .map(row => row.operation.operationId));
  // A pending review retains its read receipt and navigation. Independently
  // archived bodies can leave hot memory and are reloaded by exact result ref.
  // An older consumer merely citing those addresses (such as
  // an organization recall query) is not another unread result to pin in memory.
  const unknownControl = (ref: string) => ref.startsWith("central-semantic-attempt:")
    || ref.startsWith(CENTRAL_RESOURCE_WAIT_PREFIX) || ref.startsWith(CENTRAL_PROVIDER_WAIT_PREFIX);
  const needed = (ref: string, sourceRefs: readonly string[]) => activeWaits.has(ref) || resourceWaitRefs.has(ref)
    || agendaReadRefs.has(ref) && !archivedSources.has(ref)
    || agendaNavigationRefs.has(ref)
    // An unknown computation retains its attempt and refusal/recovery controls.
    // An archived feedback body merely mentioning it is not another live lock.
    || unknownControl(ref) && sourceRefs.some(source => unknown.has(source));
  const completed = new Set(next.completed.filter(row => !oldCompleted.has(canonicalJson(row)) || recentOperations.has(row.operation.operationId)
    || unknown.has(row.operation.operationId)
    || activeWaits.has(row.operation.operationId) || resourceWaitRefs.has(row.operation.operationId) || agendaReadOperations.has(row.operation.operationId)));
  // If another live condition retains an old read, retain its original review
  // proof with it; dropping only that proof would make the read look new again.
  const reviewedReads = [...completed].filter(row => row.intentId === "central:agenda" && row.operation.kind === "read" && row.outcome === "returned");

  for (const read of reviewedReads) {
    if ([...completed].some(review => reviewsAgendaRead(next.scope, read, review))) continue;
    const proof = next.completed.find(review => reviewsAgendaRead(next.scope, read, review));
    if (proof !== undefined) completed.add(proof);
  }

  let state: CentralLearningRuntimeState = { ...next,
    intents: next.intents.filter(row => row.continuation.kind !== "ended" || !oldEnded.has(row.intentId)),
    completed: next.completed.filter(row => completed.has(row)),
    materials: next.materials.filter(row => !oldMaterials.has(row.ref) || recentMaterials.has(row.ref) || needed(row.ref, row.sourceRefs)),
    consumedSourceRefs: [...(oldCursorRoom === 0 ? [] : oldCursor.slice(-oldCursorRoom)), ...freshConsumed] };

  // Large old bodies are available through exact archive references. Retain new
  // public results at least once instead of silently dropping their first record.
  while (canonicalJson(state).length > 98304) {
    const old = state.materials.find(row => oldMaterials.has(row.ref) && !needed(row.ref, row.sourceRefs));
    if (old !== undefined) {
      state = { ...state, materials: state.materials.filter(row => row.ref !== old.ref) };
      continue;
    }

    // Recent completions are a convenience window, not a second copy of the
    // lifetime ledger. Let already archived, settled entries leave that window
    // under real pressure before refusing a new original body. Pending work,
    // active waits, unread reads and a retained read's review proof stay pinned.
    const archived = state.completed.find(row => oldCompleted.has(canonicalJson(row))
      && !unknown.has(row.operation.operationId) && !activeWaits.has(row.operation.operationId)
      && !resourceWaitRefs.has(row.operation.operationId) && !agendaReadOperations.has(row.operation.operationId)
      && !state.completed.some(read => read.intentId === "central:agenda" && read.operation.kind === "read"
        && read.outcome === "returned" && reviewsAgendaRead(state.scope, read, row)));
    if (archived === undefined) break;

    state = { ...state, completed: state.completed.filter(row => row !== archived) };
  }

  return state;
}
