import { createHash } from "node:crypto";
import { MAX_PAYLOAD_BYTES, type Envelope, type JsonObject, type JsonValue } from "./envelope.js";
import { cutToBytes } from "./text-cut.js";
import { parseEnvelope, freezeEnvelope } from "./validate.js";

const COMPONENT = "tool_result_transport", PREFIX = "public-tool-result:";

type Identity = Pick<Envelope, "protocolVersion" | "producerId" | "sessionId" | "turnId" | "attemptId" | "correlationId">;

type Common = { readonly ref: string; readonly hash: string; readonly totalBytes: number; readonly firstProducerSequence: number };

type Part = Common & { readonly index: number; readonly start: number; readonly end: number; readonly text: string };

type Manifest = Common & { readonly parts: number };

type Frame = { readonly kind: "observation" | "tool_result"; readonly payload: JsonObject };

export type PublicToolResultFailureCode = "public_tool_result_shape" | "public_tool_result_binding" | "public_tool_result_missing"
  | "public_tool_result_range" | "public_tool_result_hash" | "public_tool_result_json" | "public_tool_result_protocol";

export class PublicToolResultError extends Error {
  constructor(readonly code: PublicToolResultFailureCode) {
    super(code);
    this.name = "PublicToolResultError";
  }
}

const fail = (code: PublicToolResultFailureCode): never => { throw new PublicToolResultError(code); };
const hashOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const identityOf = (value: Identity) => JSON.stringify([value.protocolVersion, value.producerId, value.sessionId ?? null,
  value.turnId ?? null, value.attemptId ?? null, value.correlationId ?? null]);
const refOf = (identity: Identity, common: Omit<Common, "ref">) => PREFIX + hashOf(JSON.stringify([
  identityOf(identity), common.firstProducerSequence, common.hash, common.totalBytes]));
const payloadBytes = (payload: JsonObject) => Buffer.byteLength(JSON.stringify(payload), "utf8");
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const COMMON = ["ref", "hash", "totalBytes", "firstProducerSequence"];

function common(value: Record<string, unknown>): boolean {
  return typeof value.ref === "string" && value.ref.startsWith(PREFIX) && typeof value.hash === "string"
    && /^[a-f0-9]{64}$/.test(value.hash) && natural(value.totalBytes) && value.totalBytes > MAX_PAYLOAD_BYTES
    && natural(value.firstProducerSequence);
}

function isPart(value: unknown): value is Part {
  return object(value) && fields(value, [...COMMON, "index", "start", "end", "text"]) && common(value)
    && natural(value.index) && natural(value.start) && natural(value.end) && value.end > value.start && typeof value.text === "string";
}

function isManifest(value: unknown): value is Manifest {
  return object(value) && fields(value, [...COMMON, "parts"]) && common(value) && natural(value.parts) && value.parts > 0;
}

export function isPublicToolResultPart(envelope: Envelope): boolean {
  return envelope.producerId === "loop" && envelope.kind === "observation" && envelope.payload.component === COMPONENT;
}

export function isPublicToolResultManifest(envelope: Envelope): boolean {
  return envelope.producerId === "loop" && envelope.kind === "tool_result" && envelope.payload.publicPayload !== undefined;
}

/** Lossless transport only. The complete logical result is projected by the
 * original receivers; it is never appended as an oversized physical envelope. */
export function publicToolResultFrames(payload: JsonObject, identity: Identity, firstProducerSequence: number): readonly Frame[] | undefined {
  if (payloadBytes(payload) <= MAX_PAYLOAD_BYTES) return undefined;

  if (identity.producerId !== "loop" || typeof payload.toolCallId !== "string" || typeof payload.status !== "string") return fail("public_tool_result_shape");

  const serialized = JSON.stringify(payload), bytes = Buffer.from(serialized, "utf8");
  const binding = { hash: hashOf(serialized), totalBytes: bytes.length, firstProducerSequence };
  const base = { ref: refOf(identity, binding), ...binding }, frames: Frame[] = [];
  let start = 0;

  while (start < bytes.length) {
    let windowEnd = Math.min(bytes.length, start + MAX_PAYLOAD_BYTES);

    while (windowEnd < bytes.length && (bytes[windowEnd]! & 0xc0) === 0x80) windowEnd--;

    // Work on at most one protocol window, not a new copy of the entire
    // remaining value for every fragment. Both ends are UTF-8 boundaries.
    const suffix = bytes.subarray(start, windowEnd).toString("utf8");
    const candidate = (maximum: number): JsonObject => {
      const text = cutToBytes(suffix, maximum);
      return { component: COMPONENT, part: { ...base, index: frames.length, start, end: start + Buffer.byteLength(text, "utf8"), text } };
    };
    let low = 1, high = windowEnd - start, best: JsonObject | undefined;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2), next = candidate(middle);
      if (payloadBytes(next) <= MAX_PAYLOAD_BYTES) {
        best = next;
        low = middle + 1;
      }
      else high = middle - 1;
    }

    if (best === undefined || !isPart(best.part) || best.part.end <= start) return fail("public_tool_result_protocol");

    frames.push({ kind: "observation", payload: best });
    start = best.part.end;
  }

  const manifest: JsonObject = { toolCallId: payload.toolCallId, status: payload.status,
    output: "", truncated: true, publicPayload: { ...base, parts: frames.length } };
  if (payloadBytes(manifest) > MAX_PAYLOAD_BYTES) return fail("public_tool_result_protocol");

  return [...frames, { kind: "tool_result", payload: manifest }];
}

type Pending = { readonly identity: string; readonly common: Common; readonly envelopes: Envelope[]; readonly texts: string[];
  end: number; lastSequence: number };

export type PublicToolResultRead = { readonly kind: "part" } | { readonly kind: "ordinary"; readonly value: Envelope }
  | { readonly kind: "result"; readonly value: Envelope; readonly fragments: readonly Envelope[]; readonly hash: string };

/** One ordered stream or one immutable journal prefix owns this reader. No
 * global cache, inferred fragments, provider retry or permission state. */
export function createPublicToolResultReader() {
  const pending = new Map<string, Pending>();
  return {
    close(): void { pending.clear(); },
    push(envelope: Envelope): PublicToolResultRead {
      if (!isPublicToolResultPart(envelope) && !isPublicToolResultManifest(envelope)) return { kind: "ordinary", value: envelope };

      if (!parseEnvelope(envelope).ok) return fail("public_tool_result_protocol");

      if (isPublicToolResultPart(envelope)) {
        const value = envelope.payload.part;
        if (!fields(envelope.payload, ["component", "part"]) || !isPart(value)) return fail("public_tool_result_shape");

        if (value.ref !== refOf(envelope, value)) return fail("public_tool_result_binding");

        let group = pending.get(value.ref);
        if (group === undefined) {
          if (value.index !== 0 || value.start !== 0) return fail("public_tool_result_missing");
          group = { identity: identityOf(envelope), common: value, envelopes: [], texts: [], end: 0, lastSequence: -1 };
          pending.set(value.ref, group);
        }

        if (group.identity !== identityOf(envelope) || group.common.hash !== value.hash || group.common.totalBytes !== value.totalBytes
          || group.common.firstProducerSequence !== value.firstProducerSequence) return fail("public_tool_result_binding");

        if (value.index !== group.envelopes.length || value.start !== group.end || value.end > value.totalBytes
          || value.end - value.start !== Buffer.byteLength(value.text, "utf8") || envelope.sequence <= group.lastSequence
          || envelope.producerSequence !== value.firstProducerSequence + value.index) return fail("public_tool_result_range");

        group.envelopes.push(envelope);
        group.texts.push(value.text);
        group.end = value.end;
        group.lastSequence = envelope.sequence;

        return { kind: "part" };
      }

      const manifest = envelope.payload.publicPayload;
      if (!fields(envelope.payload, ["toolCallId", "status", "output", "truncated", "publicPayload"]) || !isManifest(manifest)
        || envelope.payload.output !== "" || envelope.payload.truncated !== true) return fail("public_tool_result_shape");

      const group = pending.get(manifest.ref);
      pending.delete(manifest.ref);

      if (group === undefined || group.envelopes.length !== manifest.parts || group.end !== manifest.totalBytes) return fail("public_tool_result_missing");

      if (manifest.ref !== refOf(envelope, manifest) || group.identity !== identityOf(envelope) || group.common.hash !== manifest.hash
        || group.common.totalBytes !== manifest.totalBytes || group.common.firstProducerSequence !== manifest.firstProducerSequence
        || envelope.producerSequence !== manifest.firstProducerSequence + manifest.parts || envelope.sequence <= group.lastSequence) return fail("public_tool_result_binding");

      const serialized = group.texts.join("");
      if (Buffer.byteLength(serialized, "utf8") !== manifest.totalBytes || hashOf(serialized) !== manifest.hash) return fail("public_tool_result_hash");

      let payload: unknown;

      try { payload = JSON.parse(serialized); } catch { return fail("public_tool_result_json"); }

      if (!object(payload) || JSON.stringify(payload) !== serialized || payload.toolCallId !== envelope.payload.toolCallId
        || payload.status !== envelope.payload.status) return fail("public_tool_result_json");

      // Each physical input was strictly decoded. This logical projection may
      // exceed a frame and must only feed original render/source receivers.
      return { kind: "result", value: freezeEnvelope({ ...envelope, payload: payload as { readonly [key: string]: JsonValue } }),
        fragments: group.envelopes, hash: manifest.hash };
    },
  };
}
