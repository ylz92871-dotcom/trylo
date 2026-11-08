import {
  CREDENTIAL_FORMAT_VERSION,
  isCredentialAccountId,
  isCredentialProviderId,
  type CredentialFailure,
  type CredentialLedgerDocument,
  type CredentialProviderId,
  type CredentialRecord,
} from "../ports/credentials.js";
import { canonicalChecksum } from "./ids.js";
import { failure, toRecord, validateRecord } from "./records.js";

/**
 * The ledger document codec: JSON text <-> {@link CredentialLedgerDocument}.
 *
 * Three rules make a corrupt file unrepresentable as a valid one:
 *
 *  1. **Exact key set.** The document object must have exactly
 *     `formatVersion`, `current`, `records`, `checksum`. An extra key is a
 *     failure, not something to ignore — a file written by a newer build must be
 *     refused, not half-understood.
 *  2. **Checksum over canonical bytes.** Any edit that is not re-checksummed is
 *     detected. The checksum field itself is excluded from its own input.
 *  3. **Whole-file rejection.** A single bad record fails the whole document.
 *     There is no "skip the bad row" path, because a half-read ledger would let
 *     the next write destroy the rows the reader refused.
 *
 * `emptyDocument()` has no records and no current pointers — a freshly created
 * ledger. Its checksum is computed, not a placeholder, so a round trip through
 * encode/decode is identity even before the first login.
 */

const DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  "formatVersion",
  "current",
  "records",
  "checksum",
]);

/** The unsigned payload the checksum covers. */
type DocumentBody = {
  readonly formatVersion: typeof CREDENTIAL_FORMAT_VERSION;
  readonly current: Readonly<Partial<Record<CredentialProviderId, string>>>;
  readonly records: ReadonlyArray<CredentialRecord>;
};

export function emptyDocument(): CredentialLedgerDocument {
  return sealDocument({ formatVersion: CREDENTIAL_FORMAT_VERSION, current: {}, records: [] });
}

/** Attach a fresh checksum to a body. The one place a document is stamped. */
export function sealDocument(body: DocumentBody): CredentialLedgerDocument {
  return { ...body, checksum: canonicalChecksum(body) };
}

/** The canonical, checksum-excluded body of a document. */
export function documentBody(document: CredentialLedgerDocument): DocumentBody {
  return {
    formatVersion: document.formatVersion,
    current: document.current,
    records: document.records,
  };
}

/**
 * Serialize for disk. Key order in the output is fixed by construction so two
 * writes of the same ledger are byte-identical, which makes the file diffable
 * and the checksum trivially reproducible.
 */
export function encodeDocument(document: CredentialLedgerDocument): string {
  const ordered = {
    formatVersion: document.formatVersion,
    current: sortCurrent(document.current),
    records: document.records,
    checksum: document.checksum,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function sortCurrent(
  current: Readonly<Partial<Record<CredentialProviderId, string>>>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of Object.keys(current).sort()) {
    const value = current[key as CredentialProviderId];
    if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
}

/** Parse and fully validate ledger text. Any doubt rejects the whole file. */
export function decodeDocument(
  raw: string,
  where: string,
): { ok: true; value: CredentialLedgerDocument } | CredentialFailure {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("credentials_corrupt", `${where} is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure("credentials_corrupt", `${where} is not a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const keyFailure = checkExactKeys(record, where);
  if (keyFailure !== undefined) {
    return keyFailure;
  }

  if (record["formatVersion"] !== CREDENTIAL_FORMAT_VERSION) {
    return failure("credentials_corrupt", `${where} has unknown formatVersion`);
  }

  const current = decodeCurrent(record["current"], where);
  if (!current.ok) {
    return current;
  }

  const records = decodeRecords(record["records"], where);
  if (!records.ok) {
    return records;
  }

  const body: DocumentBody = {
    formatVersion: CREDENTIAL_FORMAT_VERSION,
    current: current.value,
    records: records.value,
  };
  const expected = canonicalChecksum(body);
  if (record["checksum"] !== expected) {
    return failure("credentials_corrupt", `${where} checksum mismatch`);
  }

  return { ok: true, value: { ...body, checksum: expected } };
}

function checkExactKeys(record: Record<string, unknown>, where: string): CredentialFailure | undefined {
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!DOCUMENT_KEYS.has(key)) {
      return failure("credentials_corrupt", `${where} has unknown key ${JSON.stringify(key)}`);
    }
  }

  for (const required of DOCUMENT_KEYS) {
    if (!keys.includes(required)) {
      return failure("credentials_corrupt", `${where} is missing ${JSON.stringify(required)}`);
    }
  }

  return undefined;
}

function decodeCurrent(
  value: unknown,
  where: string,
): { ok: true; value: Readonly<Partial<Record<CredentialProviderId, string>>> } | CredentialFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("credentials_corrupt", `${where} current is not an object`);
  }

  const out: Partial<Record<CredentialProviderId, string>> = {};

  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (!isCredentialProviderId(key)) {
      return failure("credentials_corrupt", `${where} current has unknown provider ${JSON.stringify(key)}`);
    }

    if (typeof member !== "string" || !isCredentialAccountId(member)) {
      return failure("credentials_corrupt", `${where} current has an invalid accountId`);
    }

    out[key] = member;
  }

  return { ok: true, value: out };
}

function decodeRecords(
  value: unknown,
  where: string,
): { ok: true; value: ReadonlyArray<CredentialRecord> } | CredentialFailure {
  if (!Array.isArray(value)) {
    return failure("credentials_corrupt", `${where} records is not an array`);
  }

  const out: CredentialRecord[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const at = `${where} records[${index}]`;
    const invalid = validateRecord(candidate, at);
    if (invalid !== undefined) {
      return invalid;
    }

    const record = toRecord(candidate as Record<string, unknown>);
    const key = `${record.providerId}\u0000${record.accountId}`;
    if (seen.has(key)) {
      return failure("credentials_corrupt", `${at} duplicates (${record.providerId}, ${record.accountId})`);
    }

    seen.add(key);
    out.push(record);
  }

  return { ok: true, value: out };
}
