import assert from "node:assert/strict";
import test from "node:test";
import {
  documentBody,
  emptyDocument,
  encodeDocument,
  decodeDocument,
  sealDocument,
} from "./document.js";
import type { CredentialRecord } from "../ports/credentials.js";

/**
 * The document codec is where "a corrupt file is a corrupt file" is enforced.
 * These tests pin the three rejection rules (exact key set, version, checksum),
 * the whole-file rejection of a single bad record (adversarial #3 — a bad row
 * must not be skipped so the rest stays "usable"), and a clean round trip.
 */

const RECORD: CredentialRecord = {
  formatVersion: 1,
  accountId: "acct-1",
  providerId: "openai-compatible",
  label: "work",
  secret: "sk-abcdef1234567890",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

function documentWith(records: ReadonlyArray<CredentialRecord>) {
  return sealDocument({ formatVersion: 1, current: { "openai-compatible": "acct-1" }, records });
}

test("an empty document round trips through encode/decode", () => {
  const encoded = encodeDocument(emptyDocument());
  const decoded = decodeDocument(encoded, "empty");
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.deepEqual(documentBody(decoded.value), { formatVersion: 1, current: {}, records: [] });
  }
});

test("a document with a record round trips byte-identically", () => {
  const document = documentWith([RECORD]);
  const encoded = encodeDocument(document);
  const decoded = decodeDocument(encoded, "doc");

  assert.equal(decoded.ok, true);

  if (decoded.ok) {
    assert.equal(encodeDocument(decoded.value), encoded);
  }
});

test("a checksum mismatch rejects the whole file (adversarial #2)", () => {
  const document = documentWith([RECORD]);
  const tampered = { ...document, checksum: "0".repeat(64) };
  const decoded = decodeDocument(encodeDocument(tampered), "tampered");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "credentials_corrupt");
  }
});

test("editing a record without re-checksumming is detected", () => {
  const encoded = encodeDocument(documentWith([RECORD])).replace("sk-abcdef1234567890", "sk-attacker000000000");
  const decoded = decodeDocument(encoded, "edited");
  assert.equal(decoded.ok, false);
});

test("an unknown top-level key rejects the file (adversarial #3)", () => {
  const document = documentWith([RECORD]);
  const text = JSON.stringify({ ...document, extra: "smuggled" });
  const decoded = decodeDocument(text, "extra-key");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "credentials_corrupt");
  }
});

test("an unknown record key rejects the whole file rather than skipping the row", () => {
  const document = documentWith([RECORD]);
  const tampered = sealDocument({
    formatVersion: 1,
    current: document.current,
    records: [{ ...RECORD, injected: true } as unknown as CredentialRecord],
  });
  const decoded = decodeDocument(encodeDocument(tampered), "bad-row");

  assert.equal(decoded.ok, false);
});

test("an unknown formatVersion rejects the file", () => {
  const text = JSON.stringify({
    formatVersion: 2,
    current: {},
    records: [],
    checksum: "irrelevant",
  });
  const decoded = decodeDocument(text, "v2");

  assert.equal(decoded.ok, false);
});

test("invalid JSON and an empty file both reject", () => {
  for (const raw of ["", "   ", "{", "[]", "null"]) {
    const decoded = decodeDocument(raw, "raw");
    assert.equal(decoded.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
  }
});

test("a duplicate (providerId, accountId) pair rejects the file", () => {
  const document = documentWith([RECORD, RECORD]);
  const decoded = decodeDocument(encodeDocument(document), "dup");
  assert.equal(decoded.ok, false);
});

test("a current pointer to a non-canonical accountId rejects the file", () => {
  const document = sealDocument({
    formatVersion: 1,
    current: { "openai-compatible": "UPPERCASE-NOT-ALLOWED" },
    records: [RECORD],
  });
  const decoded = decodeDocument(encodeDocument(document), "bad-current");

  assert.equal(decoded.ok, false);
});
