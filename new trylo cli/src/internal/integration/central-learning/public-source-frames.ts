import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { deepFreeze } from "../../protocol/validate.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { isRewardV2Fact, validRewardV2Prefix, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, list, sequence, text } from "../../validation/json-shape.js";
import { createRewardV2BoardPort, readRewardV2BoardReason, readRewardV2BoardWriteOutcome, type RewardV2BoardSnapshot } from "../reward/v2-board-port.js";
import { isContentValueCredentialSafe } from "../learning-content/content-confidentiality-leaf.js";
import { CENTRAL_PUBLIC_CHUNKS, encodeCentralPublicChunks, readCentralPublicChunks } from "./public-chunks.js";

export interface CentralPublicSourceFrameInput {
  readonly ref: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  /** Original source hash/coordinate and actual public-view identity stay distinct. */
  readonly origin: JsonObject;
}

export interface CentralPublicSourceFrame extends CentralPublicSourceFrameInput { readonly publicTextHash: string }

export interface CentralPublicSourceFramesOptions {
  readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean; readonly secrets?: readonly string[];
  /** Wrap the original Board only for controlled faults, never an alternate owner. */
  readonly board?: ReturnType<typeof createRewardV2BoardPort>;
}

export class CentralPublicSourceFrameError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CentralPublicSourceFrameError";
  }
}

const NAMESPACE = "central-public-source-frame";
const fail = (reason: string): never => { throw new CentralPublicSourceFrameError(reason); };
const reference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);

function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;

  if (value === null || typeof value === "boolean" || typeof value === "string") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return value.length <= 16384 && Object.keys(value).length === value.length
    && Reflect.ownKeys(value).length === value.length + 1 && value.every(item => json(item, depth + 1));

  if (typeof value !== "object" || value === null) return false;

  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);

  return (prototype === null || prototype === Object.prototype) && keys.length === Object.keys(value).length
    && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && json(Reflect.get(value, key), depth + 1));
}

function input(value: unknown): value is CentralPublicSourceFrameInput {
  return fields(value, ["ref", "text", "sourceRefs", "origin"]) && reference(value.ref)
    && text(value.text, CENTRAL_PUBLIC_CHUNKS.payloadChars) && list(value.sourceRefs, 0, 256)
    && value.sourceRefs.every(reference) && new Set(value.sourceRefs).size === value.sourceRefs.length
    && typeof value.origin === "object" && value.origin !== null && !Array.isArray(value.origin) && json(value);
}

function frame(value: unknown): value is CentralPublicSourceFrame {
  if (!fields(value, ["ref", "text", "sourceRefs", "origin", "publicTextHash"])) return false;
  const { publicTextHash, ...original } = value;
  return input(original) && publicTextHash === contentHashOf(original.text);
}

/** Official no-I/O lookup in an already loaded original Board prefix. Resolving
 * an observed archive supplies bytes, never a model-read acknowledgement. */
export function readCentralPublicSourceFrame(facts: readonly RewardV2Fact[], options: {
  readonly scope: string; readonly ref: string; readonly boardSequence: number; readonly secrets?: readonly string[];
}): CentralPublicSourceFrame | undefined {
  if (!coordinationScopeValid(options.scope) || options.scope.length > 256) fail("central_public_source_scope_invalid");

  if (!reference(options.ref)) fail("central_public_source_reference_invalid");

  if (!sequence(options.boardSequence) || !Array.isArray(facts) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, options.boardSequence)) {
    fail("central_public_source_prefix_corrupt");
  }

  const payload = readCentralPublicChunks(facts, { scope: options.scope, namespace: NAMESPACE, ref: options.ref });
  if (payload === undefined) return undefined;

  let value: unknown;

  try { value = JSON.parse(payload); }
  catch { return fail("central_public_source_corrupt"); }

  if (!fields(value, ["schemaVersion", "type", "status", "scope", "frame"]) || value.schemaVersion !== 1
    || value.type !== "central_public_source_frame" || value.status !== "observed_not_model_delivery"
    || value.scope !== options.scope || !frame(value.frame) || value.frame.ref !== options.ref || canonicalJson(value) !== payload) return fail("central_public_source_corrupt");

  if (!isContentValueCredentialSafe(value, options.secrets ?? [])) fail("central_public_source_sensitive");

  deepFreeze(value.frame.origin);
  Object.freeze(value.frame.sourceRefs);
  return Object.freeze(value.frame);
}

/** Observed public source archive only. It owns no model-delivery/read cursor,
 * domain revision, learning grant, quality judgment or permission. */
export function createCentralPublicSourceFrames(options: CentralPublicSourceFramesOptions) {
  if (!coordinationScopeValid(options.scope) || options.scope.length > 256) fail("central_public_source_scope_invalid");

  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled), secrets = [...(options.secrets ?? [])];
  const unconfirmed = new Set<readonly RewardV2Draft[]>();
  const check = (signal?: AbortSignal) => {
    if (!options.enabled()) fail("collect_disabled");
    if (signal?.aborted) fail("central_public_source_cancelled");
  };
  const address = (ref: string) => ({ scope: options.scope, namespace: NAMESPACE, ref });
  const snapshot = async (signal?: AbortSignal) => {
    check(signal);
    const current = await board.read();
    check(signal);
    return current;
  };
  const readFrame = (current: RewardV2BoardSnapshot, ref: string) => readCentralPublicSourceFrame(current.facts,
    { scope: options.scope, ref, boardSequence: current.revision, secrets });
  const sameBody = (previous: CentralPublicSourceFrame, next: CentralPublicSourceFrameInput) => {
    if (previous.text !== next.text) fail("central_public_source_conflict");
    return previous;
  };

  function missing(facts: readonly RewardV2Draft[], current: readonly RewardV2Fact[]): readonly RewardV2Draft[] {
    const index = new Map(current.map(fact => [fact.id, fact]));
    return facts.filter(fact => {
      const prior = index.get(fact.id);
      if (prior === undefined) return true;
      if (prior.scope !== fact.scope || prior.algorithmVersion !== fact.algorithmVersion || prior.kind !== fact.kind
        || prior.payloadJson !== fact.payloadJson) fail("central_public_source_conflict");
      return false;
    });
  }

  async function assertWritable(signal?: AbortSignal): Promise<void> {
    check(signal);
    if (unconfirmed.size === 0) return;
    const current = await snapshot(signal);
    for (const pending of unconfirmed) if (missing(pending, current.facts).length === 0) unconfirmed.delete(pending);
    if (unconfirmed.size > 0) fail("central_public_source_writer_suspended");
  }

  async function append(facts: readonly RewardV2Draft[], original: CentralPublicSourceFrameInput, signal?: AbortSignal): Promise<void> {
    let contention: ReturnType<typeof readRewardV2BoardReason>;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await snapshot(signal), committed = readFrame(current, original.ref);
      if (committed !== undefined) {
        sameBody(committed, original);
        return;
      }

      const pending = missing(facts, current.facts);
      if (pending.length === 0) return;

      check(signal);
      let written;

      try { written = board.appendBatch === undefined ? await board.append(current.revision, pending[0]!, signal)
        : await board.appendBatch(current.revision, pending, signal); }
      catch (error) {
        const notStarted = readRewardV2BoardWriteOutcome(error) === "not_started";

        // Only exact durable facts can clear an unknown write. Never replay an entered callback.
        if (!notStarted) unconfirmed.add(pending);

        let recovered;

        try { recovered = await snapshot(signal); }
        catch { return fail("central_public_source_write_unconfirmed"); }

        if (missing(pending, recovered.facts).length === 0) {
          unconfirmed.delete(pending);
          return;
        }

        if (notStarted && readRewardV2BoardReason(error) === "multi_writer") {
          contention = "multi_writer";
          continue;
        }

        return fail("central_public_source_write_unconfirmed");
      }

      if (written.status === "written") return;
    }

    return fail(contention === undefined ? "central_public_source_stale" : "central_public_source_write_unconfirmed");
  }

  return Object.freeze({
    async read(ref: string, signal?: AbortSignal): Promise<CentralPublicSourceFrame | undefined> {
      if (!reference(ref)) fail("central_public_source_reference_invalid");
      return readFrame(await snapshot(signal), ref);
    },

    async freeze(original: CentralPublicSourceFrameInput, signal?: AbortSignal): Promise<CentralPublicSourceFrame> {
      check(signal);

      if (!input(original)) fail("central_public_source_input_invalid");

      if (!isContentValueCredentialSafe(original, secrets)) fail("central_public_source_sensitive");

      const captured: unknown = JSON.parse(canonicalJson(original));
      if (!input(captured)) return fail("central_public_source_input_invalid");

      original = captured;
      const found = readFrame(await snapshot(signal), original.ref);
      if (found !== undefined) return sameBody(found, original);

      await assertWritable(signal);
      const prepared: CentralPublicSourceFrame = { ...original, publicTextHash: contentHashOf(original.text) };
      const payload = canonicalJson({ schemaVersion: 1, type: "central_public_source_frame", status: "observed_not_model_delivery",
        scope: options.scope, frame: prepared });
      const encoded = encodeCentralPublicChunks(address(original.ref), payload);
      const facts = [...encoded.fragments, encoded.manifest];

      // Normal source archival holds the original Board writer once; its manifest remains last.
      // Legacy injected ports keep their single-fact boundary and the same readback rules.
      if (board.appendBatch !== undefined) await append(facts, original, signal);
      else for (const fact of facts) await append([fact], original, signal);

      return readFrame(await snapshot(signal), original.ref) ?? fail("central_public_source_write_unconfirmed");
    },
  });
}
