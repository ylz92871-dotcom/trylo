import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";
import { emptyDocument } from "../../credentials/document.js";
import type { CredentialFailure, CredentialScope } from "../../ports/credentials.js";
import { createPreferReadLedgerStore } from "./prefer-store.js";

/**
 * The read order of the prefer-keyring selection (WP §3-D6 / §4 W-KEY #4).
 *
 * The store owns exactly one decision — *when* the file ledger gets consulted —
 * so these tests pin that decision and nothing else. The documents are
 * deliberately identical (`emptyDocument()`) and only `existed` differs: the hit
 * test is "the keyring has stored this scope", not "the document looks full".
 */

type Recorder = {
  readonly store: LedgerStore;
  readonly reads: CredentialScope[];
  readonly writes: CredentialScope[];
};

/** A store that records what was asked of it and answers with one canned result. */
function recordingStore(result: LedgerReadResult): Recorder {
  const reads: CredentialScope[] = [];
  const writes: CredentialScope[] = [];

  return {
    reads,
    writes,
    store: {
      read: (scope) => {
        reads.push(scope);
        return result;
      },
      write: (scope) => {
        writes.push(scope);
        return undefined;
      },
    },
  };
}

function missing(): LedgerReadResult {
  return { ok: true, document: emptyDocument(), existed: false };
}

function stored(): LedgerReadResult {
  return { ok: true, document: emptyDocument(), existed: true };
}

function unreadable(): CredentialFailure {
  return { ok: false, code: "read_failed", detail: "the keyring entry could not be read" };
}

test("a scope the keyring has stored is answered by the keyring alone", () => {
  const canned = stored();
  const preferred = recordingStore(canned);
  const fallback = recordingStore(missing());
  const store = createPreferReadLedgerStore({ preferred: preferred.store, fallback: fallback.store });

  const result = store.read("user");

  // Identity, not a copy: the keyring's own answer is handed back untouched.
  assert.equal(result, canned);
  assert.deepEqual(preferred.reads, ["user"]);
  assert.deepEqual(fallback.reads, [], "a stored keyring scope must not consult the file ledger");
});

test("a scope the keyring has never stored defers to the file ledger", () => {
  const preferred = recordingStore(missing());
  const fallback = recordingStore(stored());
  const store = createPreferReadLedgerStore({ preferred: preferred.store, fallback: fallback.store });

  const result = store.read("project");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.existed, true);
  assert.deepEqual(preferred.reads, ["project"]);
  assert.deepEqual(fallback.reads, ["project"]);
});

test("a keyring that cannot be read stays a failure; the file ledger is never a silent substitute", () => {
  const preferred = recordingStore(unreadable());
  const fallback = recordingStore(stored());
  const store = createPreferReadLedgerStore({ preferred: preferred.store, fallback: fallback.store });

  const result = store.read("user");

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "read_failed");
  assert.deepEqual(fallback.reads, [], "a failed keyring read must not fall back to a file");
});

test("writes go to the keyring only, never to the fallback", () => {
  const preferred = recordingStore(stored());
  const fallback = recordingStore(missing());
  const store = createPreferReadLedgerStore({ preferred: preferred.store, fallback: fallback.store });

  const failure = store.write("user", emptyDocument());

  assert.equal(failure, undefined);
  assert.deepEqual(preferred.writes, ["user"]);
  assert.deepEqual(fallback.writes, [], "the file ledger must not receive a new secret after opt-in");
});
