import { createHash } from "node:crypto";
import type { Envelope } from "../protocol/envelope.js";

export function envelopeChecksum(envelope: Envelope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        kind: envelope.kind,
        producerId: envelope.producerId,
        producerSequence: envelope.producerSequence,
      }),
    )
    .digest("hex");
}

export function verifyJournal(
  envelopes: readonly Envelope[],
  checksums: readonly string[],
): { ok: true } | { ok: false; code: "checksum" } {
  if (envelopes.length !== checksums.length) {
    return { ok: false, code: "checksum" };
  }

  for (let i = 0; i < envelopes.length; i += 1) {
    const envelope = envelopes[i];
    const expected = checksums[i];
    if (envelope === undefined || expected === undefined) {
      return { ok: false, code: "checksum" };
    }

    if (envelopeChecksum(envelope) !== expected) {
      return { ok: false, code: "checksum" };
    }
  }

  return { ok: true };
}
