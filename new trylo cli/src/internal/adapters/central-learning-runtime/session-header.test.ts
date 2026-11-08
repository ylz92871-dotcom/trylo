import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeLine } from "../session-store/codec.js";
import type { SessionRecord } from "../../ports/session.js";
import { readRuntimeSessionHeader } from "./session-header.js";

const signal = new AbortController().signal;
const MAXIMUM_BYTES = 65536;

function fixture(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-session-header-")), "session.ndjson");
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "source-session", at: "2026-11-05T04:00:00.000Z",
    payload: { fingerprint: { schemaVersion: "1", workspaceId: "workspace:original", providerId: "local", model: "local", toolCatalogHash: "catalog" } },
    ...overrides };
}

test("the original checksummed header supplies identity even when the later journal body is large and corrupt", async () => {
  const file = fixture(), line = encodeLine(0, record());
  const contents = line + "NOT_A_JOURNAL_LINE\n" + "private-body-marker".repeat(100000);

  writeFileSync(file, contents);
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), {
    ok: true, value: { sessionId: "source-session", workspaceId: "workspace:original" },
  });
  assert.equal(readFileSync(file, "utf8"), contents, "header inspection cannot repair, truncate or acquire the journal writer");
});

test("an explicit workspace root is returned without changing the original workspace or session identity", async () => {
  const file = fixture(), workspaceRoot = "D:\\CC\\trylo\\new trylo cli";
  const fingerprint = { schemaVersion: "1", workspaceId: "workspace:original", workspaceRoot,
    providerId: "local", model: "local", toolCatalogHash: "catalog" };
  const contents = encodeLine(0, record({ payload: { fingerprint } })) + "INVALID_LATER_JOURNAL_BODY\n";

  writeFileSync(file, contents);
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), {
    ok: true, value: { sessionId: "source-session", workspaceId: "workspace:original", workspaceRoot },
  });
  assert.equal(readFileSync(file, "utf8"), contents);
});

test("a present workspace root with an invalid contract shape cannot establish a header identity", async () => {
  const file = fixture();
  for (const workspaceRoot of [null, 17, [], {}, "", "D:\\invalid\0root"]) {
    const fingerprint = { schemaVersion: "1", workspaceId: "workspace:original", workspaceRoot,
      providerId: "local", model: "local", toolCatalogHash: "catalog" };
    const contents = encodeLine(0, record({ payload: { fingerprint } }));
    writeFileSync(file, contents);
    assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), { ok: false, reason: "session_header_invalid" });
    assert.equal(readFileSync(file, "utf8"), contents);
  }
});

test("wrong checksums, versions, sequences, record roles, fingerprints and expected session identities fail closed", async () => {
  const file = fixture(), valid = encodeLine(0, record());
  const invalid = [valid.replace('"sum":"', '"sum":"wrong-'), encodeLine(0, record({ formatVersion: "unknown" })),
    encodeLine(1, record({ sequence: 1 })), encodeLine(0, record({ type: "turn_input" })),
    encodeLine(0, record({ payload: { fingerprint: null } })), encodeLine(0, record({ payload: {} })),
    encodeLine(0, record({ sessionId: "different-session" })), "null\n", "17\n", "{}\n", "\n" + valid];

  for (const contents of invalid) {
    writeFileSync(file, contents);
    assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), { ok: false, reason: "session_header_invalid" });
    assert.equal(readFileSync(file, "utf8"), contents);
  }
});

test("an incomplete or empty first line is not an empty registry entry", async () => {
  const file = fixture(), complete = encodeLine(0, record());
  for (const contents of ["", complete.slice(0, -1), "{\"sequence\":0"]) {
    writeFileSync(file, contents);
    assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), { ok: false, reason: "session_header_invalid" });
  }
});

test("a complete header at the byte bound is accepted while a newline beyond that bound is refused", async () => {
  const file = fixture(), base = record({ payload: { ...record().payload, padding: "" } });
  const padding = "x".repeat(MAXIMUM_BYTES - Buffer.byteLength(encodeLine(0, base), "utf8"));
  const exact = encodeLine(0, { ...base, payload: { ...base.payload, padding } });

  assert.equal(Buffer.byteLength(exact, "utf8"), MAXIMUM_BYTES);
  writeFileSync(file, exact + "private later bytes");
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), {
    ok: true, value: { sessionId: "source-session", workspaceId: "workspace:original" },
  });
  writeFileSync(file, encodeLine(0, { ...base, payload: { ...base.payload, padding: padding + "x" } }));
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), { ok: false, reason: "session_header_capacity" });
});

test("missing, non-file IO failures and cancellation remain separate from invalid or foreign identity", async () => {
  const file = fixture();

  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), { ok: false, reason: "session_header_missing" });
  assert.deepEqual(await readRuntimeSessionHeader(path.dirname(file), "source-session", signal), { ok: false, reason: "session_header_io" });
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", cancelled.signal), { ok: false, reason: "session_header_cancelled" });
  writeFileSync(file, encodeLine(0, record()));
  const interrupted = new AbortController();
  const pending = readRuntimeSessionHeader(file, "source-session", interrupted.signal);

  interrupted.abort();
  assert.deepEqual(await pending, { ok: false, reason: "session_header_cancelled" });
  assert.deepEqual(await readRuntimeSessionHeader(file, "source-session", signal), {
    ok: true, value: { sessionId: "source-session", workspaceId: "workspace:original" },
  });
});
