import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralDeliberationOutput, isCentralLearningOperation, isCentralLearningRuntimeState,
  isCentralLearningSubject, isCentralRuntimeMaterial, isCentralRuntimeReferences, isCentralThoughtMaxTokens } from "../../learning/central/runtime/validation.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { centralBudgetReference, isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity, list, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort, readRewardV2BoardReason, readRewardV2BoardWriteOutcome } from "../reward/v2-board-port.js";
import { isReasonCode, type ReasonCode } from "../../learning/control/reasons.js";
import { isContentValueCredentialSafe } from "../learning-content/content-confidentiality-leaf.js";
import { isCentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { buildCentralDeliberationWireEvidence, isCentralDeliberationWireEvidence,
  type CentralDeliberationWireEvidence, type CentralDeliberationWireEvidenceInput } from "./deliberation-wire-evidence.js";
import { isActivePurposeDelivery } from "./active-purpose-delivery.js";
import { isCentralActionWireFormat } from "./deliberation-encoding.js";

export type { CentralDeliberationWireEvidence, CentralDeliberationWireEvidenceInput } from "./deliberation-wire-evidence.js";

const DELIVERY_ALGORITHM = "central-deliberation-delivery-v1", CHUNK_ALGORITHM = "central-deliberation-public-chunk-v1";
const CHUNK_CHARS = 8192, MAX_PAYLOAD_CHARS = 1024 * 1024, MAX_CHUNKS = MAX_PAYLOAD_CHARS / CHUNK_CHARS;
// Process-local derived computation only: no receipt objects, authority or
// secrets are retained. A miss/eviction performs the original full validation.
const verifiedPayloadHashes = new Set<string>();
const MAX_VERIFIED_PAYLOAD_HASHES = 4096;
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const prose = (value: unknown): value is string => typeof value === "string" && value.length <= CENTRAL_RUNTIME_LIMITS.textChars
  && [...value].every(character => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
const statements = (value: unknown): boolean => list(value, 0, CENTRAL_RUNTIME_LIMITS.statements) && value.every(prose);

export interface CentralDeliberationDelivery {
  readonly request: CentralDeliberationRequest;
  readonly output: CentralDeliberationOutput;
  readonly deliveryRef: string;
  /** The immutable delivery contains all original citations; this ref does not create another observation. */
  readonly sourceRefs: readonly string[];
  /** Absent on legacy deliveries: the canonical request alone proves no exact model exposure. */
  readonly wireEvidence?: CentralDeliberationWireEvidence;
}

export interface CentralDeliberationReceiptInput {
  readonly request: CentralDeliberationRequest;
  readonly output: CentralDeliberationOutput;
  readonly wireEvidence?: CentralDeliberationWireEvidence;
}

export interface CentralDeliberationReceiptsPort {
  read(operationId: string, signal?: AbortSignal): Promise<CentralDeliberationDelivery | undefined>;
  save(input: CentralDeliberationReceiptInput, signal?: AbortSignal): Promise<CentralDeliberationDelivery>;
  /** Local writer state only; existing receipt reads remain available. Legacy injected ports may omit it. */
  assertWritable?(signal?: AbortSignal): Promise<void>;
}

export interface CentralDeliberationReceiptsOptions {
  readonly boardRoot: string; readonly scope: string; readonly budgetId: string;
  readonly enabled: () => boolean; readonly secrets?: readonly string[];
  /** The same original Board port may be wrapped for fault injection, never an alternate persistence owner. */
  readonly board?: ReturnType<typeof createRewardV2BoardPort>;
}

const RECEIPT_REASONS = ["collect_disabled", "central_deliberation_receipt_board_unavailable", "central_deliberation_receipt_cancelled",
  "central_deliberation_receipt_capacity", "central_deliberation_receipt_conflict", "central_deliberation_receipt_corrupt",
  "central_deliberation_receipt_identity_invalid", "central_deliberation_receipt_input_invalid", "central_deliberation_receipt_prefix_corrupt",
  "central_deliberation_receipt_sensitive", "central_deliberation_receipt_stale", "central_deliberation_receipt_write_unconfirmed",
  "central_deliberation_receipt_writer_suspended", "central_deliberation_receipt_unclassified"] as const;

export interface CentralDeliberationReceiptFailure {
  readonly reason: typeof RECEIPT_REASONS[number];
  readonly boardReason?: ReasonCode;
}

export class CentralDeliberationReceiptError extends Error {
  constructor(readonly reason: string,readonly boardReason?: ReasonCode) {
    super(reason);
    this.name = "CentralDeliberationReceiptError";
  }
}

export function readCentralDeliberationReceiptFailure(error: unknown): CentralDeliberationReceiptFailure {
  const fallback = { reason: "central_deliberation_receipt_unclassified" as const };
  if (!(error instanceof CentralDeliberationReceiptError)) return fallback;
  const reason = RECEIPT_REASONS.find(value => value === error.reason) ?? fallback.reason;
  const boardReason = error.boardReason !== undefined && isReasonCode(error.boardReason) ? error.boardReason : undefined;
  return { reason, ...(boardReason === undefined ? {} : { boardReason }) };
}

const fail = (reason: string,boardReason?: ReasonCode): never => {
  throw new CentralDeliberationReceiptError(reason,boardReason);
};

/** Capture only public, actual post-reservation wire inputs; no provider response envelope or reasoning. */
export function createCentralDeliberationWireEvidence(input: CentralDeliberationWireEvidenceInput,
  secrets: readonly string[] = []): CentralDeliberationWireEvidence {
  if (!isContentValueCredentialSafe(input, secrets)) return fail("central_deliberation_receipt_sensitive");

  const optional = typeof input === "object" && input !== null && Object.hasOwn(input, "format") ? ["format"] : [];
  if (!fields(input, ["request", "output", "rawChange", "wire", ...optional])
    || optional.length > 0 && !isCentralActionWireFormat(input.format)
    || !isCentralDeliberationReceiptRequest(input.request) || !isCentralDeliberationOutput(input.output)) {
    return fail("central_deliberation_receipt_input_invalid");
  }

  return buildCentralDeliberationWireEvidence(input) ?? fail("central_deliberation_receipt_input_invalid");
}

function configuration(value: unknown): value is CentralDeliberationRequest["configuration"] {
  if (typeof value !== "object" || value === null) return false;

  const optional = ["rootRef", "providerConnectionRef", "generationRef", "thoughtMaxTokens", "generationLimits"].filter(key => Object.hasOwn(value, key));

  return fields(value, ["schemaVersion", "configurationRef", "authorizationRef", "allowance", ...optional]) && value.schemaVersion === 1
    && identity(value.configurationRef) && centralBudgetReference(value.authorizationRef) && isCentralLearningAllowance(value.allowance)
    && (!Object.hasOwn(value, "rootRef") || isCentralLearningBudgetRootRef(value.rootRef))
    && (!Object.hasOwn(value, "providerConnectionRef") || identity(value.providerConnectionRef))
    && (!Object.hasOwn(value, "generationRef") || identity(value.generationRef))
    && (!Object.hasOwn(value, "generationLimits") || isCentralGenerationLimits(value.generationLimits))
    && (!Object.hasOwn(value, "thoughtMaxTokens") || isCentralThoughtMaxTokens(value.thoughtMaxTokens));
}

function resources(value: unknown): value is CentralDeliberationRequest["resources"] {
  return fields(value, ["boardSequence", "budgetId", "limits", "occupied", "available", "status", "holdReason"])
    && sequence(value.boardSequence) && centralBudgetReference(value.budgetId) && isCentralLearningResources(value.limits)
    && isCentralLearningResources(value.occupied) && fields(value.available, ["tokens", "calls", "steps"])
    && Object.values(value.available).every(item => typeof item === "number" && Number.isSafeInteger(item) && Math.abs(item) <= 1_000_000_000)
    && ["available", "exhausted", "held"].includes(String(value.status)) && (value.holdReason === null || prose(value.holdReason));
}

/** Composition of canonical domain guards at this serialized provider boundary; no new request type or policy. */
export function isCentralDeliberationReceiptRequest(value: unknown): value is CentralDeliberationRequest {
  const optional = typeof value === "object" && value !== null && Object.hasOwn(value, "activePurposeDelivery") ? ["activePurposeDelivery"] : [];
  if (!fields(value, ["schemaVersion", "scope", "budgetId", "configuration", "boardSequence", "resources", "stateRef", "state",
    "opportunities", "materials", "organization", "operation", ...optional]) || value.schemaVersion !== 1 || !coordinationScopeValid(value.scope)
    || !centralBudgetReference(value.budgetId) || !configuration(value.configuration) || !sequence(value.boardSequence)
    || !resources(value.resources) || !identity(value.stateRef) || !isCentralLearningRuntimeState(value.state)
    || value.state.scope !== value.scope || !isCentralLearningOperation(value.operation) || value.operation.kind !== "think") return false;

  if (optional.length > 0 && !isActivePurposeDelivery(value.activePurposeDelivery, value.state.intents)) return false;

  if (!list(value.opportunities, 0, CENTRAL_RUNTIME_LIMITS.intents) || !value.opportunities.every(opportunity =>
    fields(opportunity, ["subject", "sourceRef", "description", "constraints"]) && isCentralLearningSubject(opportunity.subject)
      && isCentralRuntimeReferences([opportunity.sourceRef]) && prose(opportunity.description) && statements(opportunity.constraints))) return false;

  if (!list(value.materials, 0, CENTRAL_RUNTIME_LIMITS.materials) || !value.materials.every(isCentralRuntimeMaterial)
    || !list(value.organization, 0, CENTRAL_RUNTIME_LIMITS.materials) || !value.organization.every(isCentralRuntimeMaterial)) return false;

  if (value.configuration.rootRef !== undefined
    && (value.configuration.rootRef.scope !== value.scope
      || value.configuration.rootRef.budgetId !== value.budgetId)) return false;

  return value.resources.budgetId === value.budgetId && value.resources.boardSequence <= value.boardSequence;
}

interface Manifest {
  readonly schemaVersion: 1; readonly type: "central_deliberation_public_delivery";
  readonly budgetId: string; readonly operationId: string; readonly payloadHash: string; readonly chunks: readonly string[];
}

interface PublicPayload { readonly schemaVersion: 1; readonly type: "central_deliberation_public_result";
  readonly status: "public_model_result_not_independent_verification";
  readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
  readonly wireEvidence?: CentralDeliberationWireEvidence }

function manifest(value: unknown): value is Manifest {
  return fields(value, ["schemaVersion", "type", "budgetId", "operationId", "payloadHash", "chunks"]) && value.schemaVersion === 1
    && value.type === "central_deliberation_public_delivery" && centralBudgetReference(value.budgetId) && identity(value.operationId)
    && isHash(value.payloadHash) && list(value.chunks, 1, MAX_CHUNKS) && value.chunks.every(identity) && new Set(value.chunks).size === value.chunks.length;
}

function publicPayload(value: unknown): value is PublicPayload {
  const optional = typeof value === "object" && value !== null && Object.hasOwn(value, "wireEvidence") ? ["wireEvidence"] : [];
  return fields(value, ["schemaVersion", "type", "status", "request", "output", ...optional]) && value.schemaVersion === 1
    && value.type === "central_deliberation_public_result" && value.status === "public_model_result_not_independent_verification"
    && isCentralDeliberationReceiptRequest(value.request) && isCentralDeliberationOutput(value.output)
    && (optional.length === 0 || isCentralDeliberationWireEvidence(value.wireEvidence, value.request, value.output));
}

const deliveryId = (scope: string, budgetId: string, operationId: string): string =>
  `central-deliberation-delivery:${contentHashOf([scope, budgetId, operationId])}`;

function draft(scope: string, algorithmVersion: string, id: string, value: unknown): RewardV2Draft {
  const fact = { scope, algorithmVersion, id, kind: "projection" as const, payloadJson: canonicalJson(value) };
  return isRewardV2Draft(fact) ? fact : fail("central_deliberation_receipt_capacity");
}

function parse(payloadJson: string): unknown {
  try { return JSON.parse(payloadJson); }
  catch { return fail("central_deliberation_receipt_corrupt"); }
}

/** Called only for a fresh JSON.parse after every original fragment and the
 * complete payload hash have been checked. Identical serialized JSON has the
 * same pure request/output/wire reconstruction; access and secret checks are
 * deliberately outside this memo and run again for every read. */
function verifiedPublicPayload(payload: unknown, payloadHash: string): payload is PublicPayload {
  return verifiedPayloadHashes.has(payloadHash) || publicPayload(payload);
}

function rememberPublicPayload(payloadHash: string): void {
  if (verifiedPayloadHashes.has(payloadHash)) return;
  if (verifiedPayloadHashes.size >= MAX_VERIFIED_PAYLOAD_HASHES) {
    const oldest = verifiedPayloadHashes.values().next().value;
    if (oldest !== undefined) verifiedPayloadHashes.delete(oldest);
  }
  verifiedPayloadHashes.add(payloadHash);
}

function deliveryFromFacts(facts: ReadonlyMap<string, RewardV2Fact>, scope: string, deliveryRef: string,
  secrets: readonly string[]): CentralDeliberationDelivery | undefined {
  const committed = facts.get(deliveryRef);
  if (committed === undefined) return undefined;

  const value = parse(committed.payloadJson);
  if (committed.scope !== scope || committed.algorithmVersion !== DELIVERY_ALGORITHM || committed.kind !== "projection"
    || !manifest(value) || deliveryId(scope, value.budgetId, value.operationId) !== deliveryRef
    || draft(scope, DELIVERY_ALGORITHM, deliveryRef, value).payloadJson !== committed.payloadJson) return fail("central_deliberation_receipt_corrupt");

  const parts: string[] = [];

  for (const [index, chunkId] of value.chunks.entries()) {
    const fact = facts.get(chunkId), chunk = fact === undefined ? undefined : parse(fact.payloadJson);
    if (fact === undefined || fact.scope !== scope || fact.algorithmVersion !== CHUNK_ALGORITHM || fact.kind !== "projection"
      || fact.sequence >= committed.sequence || !fields(chunk, ["schemaVersion", "type", "budgetId", "operationId", "payloadHash", "index", "text"])
      || chunk.schemaVersion !== 1 || chunk.type !== "central_deliberation_public_fragment" || chunk.budgetId !== value.budgetId
      || chunk.operationId !== value.operationId || chunk.payloadHash !== value.payloadHash || chunk.index !== index
      || typeof chunk.text !== "string" || chunk.text.length < 1 || chunk.text.length > CHUNK_CHARS
      || chunkId !== `central-deliberation-chunk:${contentHashOf([scope, value.budgetId, value.operationId, value.payloadHash, index, chunk.text])}`
      || draft(scope, CHUNK_ALGORITHM, chunkId, chunk).payloadJson !== fact.payloadJson) return fail("central_deliberation_receipt_corrupt");

    parts.push(chunk.text);
  }

  const payloadJson = parts.join("");
  if (payloadJson.length > MAX_PAYLOAD_CHARS || sha256Hex(payloadJson) !== value.payloadHash) return fail("central_deliberation_receipt_corrupt");

  const payload = parse(payloadJson);
  if (!verifiedPublicPayload(payload, value.payloadHash) || payload.request.scope !== scope || payload.request.budgetId !== value.budgetId
    || payload.request.operation.operationId !== value.operationId || payload.request.boardSequence >= committed.sequence
    || canonicalJson(payload) !== payloadJson || !isContentValueCredentialSafe(payload, secrets)) return fail("central_deliberation_receipt_corrupt");

  rememberPublicPayload(value.payloadHash);

  return { request: payload.request, output: payload.output, deliveryRef, sourceRefs: [deliveryRef],
    ...(payload.wireEvidence === undefined ? {} : { wireEvidence: payload.wireEvidence }) };
}

/** Decode original immutable deliveries from one verified Board prefix. This
 * shares the receipt parser with the live port and performs no IO or writes. */
export function readCentralDeliberationDeliveriesFromFacts(facts: readonly RewardV2Fact[], scope: string,
  boardSequence: number, deliveryRefs: readonly string[], secrets: readonly string[] = []): readonly (CentralDeliberationDelivery | undefined)[] {
  return createCentralDeliberationDeliveryReader(facts, scope, boardSequence, secrets)(deliveryRefs);
}

/** One exact prefix for a synchronous provenance traversal. Snapshot primitive
 * fact fields so caller mutation cannot replace the validated original bytes.
 * Each requested receipt still passes the original chunk/hash/schema checks. */
export function createCentralDeliberationDeliveryReader(facts: readonly RewardV2Fact[], scope: string,
  boardSequence: number, secrets: readonly string[] = []): (deliveryRefs: readonly string[]) => readonly (CentralDeliberationDelivery | undefined)[] {
  if (!coordinationScopeValid(scope) || !sequence(boardSequence) || !facts.every(isRewardV2Fact)
    || !validRewardV2Prefix(facts, boardSequence)) return fail("central_deliberation_receipt_prefix_corrupt");
  const index = new Map(facts.map(fact => [fact.id, { ...fact }])), originalSecrets = [...secrets];

  return deliveryRefs => {
    if (!deliveryRefs.every(identity)) return fail("central_deliberation_receipt_identity_invalid");
    return deliveryRefs.map(ref => deliveryFromFacts(index, scope, ref, originalSecrets));
  };
}

/** All fragments and the commit marker use the original lock/reducer/log. Fragments alone never claim a response returned. */
export function createCentralDeliberationReceiptsAtRoot(options: CentralDeliberationReceiptsOptions): CentralDeliberationReceiptsPort {
  if (!coordinationScopeValid(options.scope) || !centralBudgetReference(options.budgetId)) fail("central_deliberation_receipt_identity_invalid");

  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled), secrets = [...(options.secrets ?? [])];
  const unconfirmed = new Set<readonly RewardV2Draft[]>();
  const check = (signal?: AbortSignal) => {
    if (!options.enabled()) fail("collect_disabled");
    if (signal?.aborted === true) fail("central_deliberation_receipt_cancelled");
  };

  async function snapshot(signal?: AbortSignal) {
    check(signal);
    let read;

    try { read = await board.read(); }
    catch (error) { return fail("central_deliberation_receipt_board_unavailable", readRewardV2BoardReason(error)); }

    check(signal);

    if (!sequence(read.revision) || !read.facts.every(isRewardV2Fact) || !validRewardV2Prefix(read.facts, read.revision)) {
      return fail("central_deliberation_receipt_prefix_corrupt");
    }

    return read;
  }

  function fromFacts(facts: readonly RewardV2Fact[], operationId: string): CentralDeliberationDelivery | undefined {
    return deliveryFromFacts(new Map(facts.map(fact => [fact.id, fact])), options.scope,
      deliveryId(options.scope, options.budgetId, operationId), secrets);
  }

  function missing(facts: readonly RewardV2Draft[], current: readonly RewardV2Fact[]): readonly RewardV2Draft[] {
    const index = new Map(current.map(row => [row.id, row]));
    return facts.filter(fact => {
      const existing = index.get(fact.id);
      if (existing === undefined) return true;
      if (existing.scope !== fact.scope || existing.algorithmVersion !== fact.algorithmVersion
        || existing.kind !== fact.kind || existing.payloadJson !== fact.payloadJson) fail("central_deliberation_receipt_conflict");
      return false;
    });
  }

  async function assertWritable(signal?: AbortSignal): Promise<void> {
    check(signal);
    if (unconfirmed.size === 0) return;
    const current = await snapshot(signal);
    for (const pending of unconfirmed) if (missing(pending, current.facts).length === 0) unconfirmed.delete(pending);
    if (unconfirmed.size > 0) fail("central_deliberation_receipt_writer_suspended");
  }

  async function append(facts: readonly RewardV2Draft[], signal?: AbortSignal): Promise<void> {
    // Retry only stale CAS or proved pre-entry contention, never an entered callback.
    // Exact durable readback confirms an acknowledgement loss without appending again.
    let contention: ReturnType<typeof readRewardV2BoardReason>;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await snapshot(signal), pending = missing(facts, current.facts);
      if (pending.length === 0) return;

      check(signal);
      let written;

      try { written = board.appendBatch === undefined ? await board.append(current.revision, pending[0]!, signal)
        : await board.appendBatch(current.revision, pending, signal); }
      catch (error) {
        const reason = readRewardV2BoardReason(error), notStarted = readRewardV2BoardWriteOutcome(error) === "not_started";
        if (!notStarted) unconfirmed.add(pending);

        let recovered;

        try { recovered = await snapshot(signal); }
        catch { return fail("central_deliberation_receipt_write_unconfirmed", reason); }

        if (missing(pending, recovered.facts).length === 0) {
          unconfirmed.delete(pending);
          return;
        }

        if (notStarted && reason === "multi_writer") {
          contention = reason;
          continue;
        }

        return fail("central_deliberation_receipt_write_unconfirmed", reason);
      }

      if (written.status === "written") return;
    }

    return contention === undefined ? fail("central_deliberation_receipt_stale") : fail("central_deliberation_receipt_write_unconfirmed", contention);
  }

  return Object.freeze({
    assertWritable,

    async read(operationId: string, signal?: AbortSignal) {
      if (!identity(operationId)) fail("central_deliberation_receipt_identity_invalid");
      const current = await snapshot(signal);
      return fromFacts(current.facts, operationId);
    },

    async save(input: CentralDeliberationReceiptInput, signal?: AbortSignal) {
      check(signal);
      const optional = typeof input === "object" && input !== null && Object.hasOwn(input, "wireEvidence") ? ["wireEvidence"] : [];
      if (!fields(input, ["request", "output", ...optional]) || !isCentralDeliberationReceiptRequest(input.request) || !isCentralDeliberationOutput(input.output)
        || input.request.scope !== options.scope || input.request.budgetId !== options.budgetId) return fail("central_deliberation_receipt_input_invalid");

      if (!isContentValueCredentialSafe(input, secrets)) return fail("central_deliberation_receipt_sensitive");

      const operationId = input.request.operation.operationId, current = await snapshot(signal), existing = fromFacts(current.facts, operationId);
      const payload: PublicPayload = { schemaVersion: 1, type: "central_deliberation_public_result",
        status: "public_model_result_not_independent_verification", ...input }, payloadJson = canonicalJson(payload);

      // The serialized boundary must pass too: sparse arrays/accessors cannot commit a payload that fails replay.
      if (!publicPayload(parse(payloadJson))) return fail("central_deliberation_receipt_input_invalid");

      if (existing !== undefined) {
        if (canonicalJson({ request: existing.request, output: existing.output,
          ...(existing.wireEvidence === undefined ? {} : { wireEvidence: existing.wireEvidence }) }) !== canonicalJson(input)) {
          return fail("central_deliberation_receipt_conflict");
        }
        return existing;
      }

      await assertWritable(signal);

      if (payloadJson.length > MAX_PAYLOAD_CHARS) return fail("central_deliberation_receipt_capacity");

      const payloadHash = sha256Hex(payloadJson), chunks: string[] = [], facts: RewardV2Draft[] = [];

      for (let start = 0, index = 0; start < payloadJson.length; start += CHUNK_CHARS, index += 1) {
        const part = payloadJson.slice(start, start + CHUNK_CHARS), id = `central-deliberation-chunk:${contentHashOf([options.scope, options.budgetId, operationId, payloadHash, index, part])}`;
        const body = { schemaVersion: 1, type: "central_deliberation_public_fragment", budgetId: options.budgetId, operationId, payloadHash, index, text: part };
        facts.push(draft(options.scope, CHUNK_ALGORITHM, id, body));
        chunks.push(id);
      }

      const deliveryRef = deliveryId(options.scope, options.budgetId, operationId);
      const body: Manifest = { schemaVersion: 1, type: "central_deliberation_public_delivery", budgetId: options.budgetId, operationId, payloadHash, chunks };

      facts.push(draft(options.scope, DELIVERY_ALGORITHM, deliveryRef, body));

      // Normal persistence acquires the original writer once, preventing PA interleaving between fragments.
      // Older fault-injected ports retain the single-fact path and the same readback rules.
      if (board.appendBatch !== undefined) await append(facts, signal);
      else for (const fact of facts) await append([fact], signal);

      const saved = fromFacts((await snapshot(signal)).facts, operationId);

      return saved ?? fail("central_deliberation_receipt_write_unconfirmed");
    },
  });
}
