import assert from "node:assert/strict";
import test from "node:test";
import { bindVerbs, type PortDeps } from "./verbs.js";
import { createMemoryLedgerStore } from "../adapters/credentials/memory-ledger-store.js";
import type { CredentialPort } from "../ports/credentials.js";

/**
 * The port contract — the behaviour every verb promises, independent of backend.
 *
 * Built over the in-memory ledger so the tests exercise the *semantics*: two
 * scopes, a current pointer per provider, refusal rules, and the guarantee that
 * no public view carries a secret. The file backend's storage rules get their
 * own suite; this one would be the same for a keyring.
 */

const NOW = "2026-09-15T12:00:00.000Z";

function makePort(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly hasProject?: boolean;
  } = {},
): CredentialPort {
  let counter = 0;
  const deps: PortDeps = {
    store: createMemoryLedgerStore(),
    env: options.env ?? {},
    now: () => NOW,
    crypto: {
      randomUUID: () => {
        counter += 1;
        return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      },
    },
    hasProject: options.hasProject ?? false,
  };

  return bindVerbs(deps);
}

async function ok<T>(result: { ok: true; value: T } | { ok: false }): Promise<T> {
  assert.equal(result.ok, true);
  return (result as { ok: true; value: T }).value;
}

function code(result: { ok: boolean; code?: string }): string {
  assert.equal(result.ok, false);
  return result.code ?? "";
}

// --- login / get -----------------------------------------------------------

test("login stores a keyed credential and get returns it with the secret", async () => {
  const port = makePort();
  const stored = await ok(port.login({ providerId: "openai-compatible", secret: "sk-secret", label: "work" }));

  assert.equal(stored.accountId.length > 0, true);
  const resolved = await ok(port.get("openai-compatible"));

  assert.equal(resolved.layer, "user");
  assert.equal(resolved.secret, "sk-secret");
  assert.equal(resolved.label, "work");
});

test("login defaults to the user scope; project must be explicit", async () => {
  const port = makePort();
  await ok(port.login({ providerId: "openai-compatible", secret: "sk-secret" }));
  const entries = await ok(port.list());
  assert.deepEqual(entries.map((entry) => entry.scope), ["user"]);
});

test("a keyed provider without a secret is refused", () => {
  const port = makePort();
  assert.equal(code(port.login({ providerId: "openai-compatible" })), "missing_secret");
});

test("fixture login may omit the secret, and get on an empty fixture is ok:none", async () => {
  const port = makePort();
  const empty = await ok(port.get("fixture"));

  assert.equal(empty.layer, "none");
  assert.equal(empty.secret, undefined);

  await ok(port.login({ providerId: "fixture" }));
  const resolved = await ok(port.get("fixture"));

  assert.equal(resolved.layer, "user");
  assert.equal(resolved.secret, undefined);
});

test("an unknown provider is refused on every verb that takes one", () => {
  const port = makePort();
  assert.equal(code(port.login({ providerId: "anthropic" as never })), "unknown_provider");
  assert.equal(code(port.get("anthropic" as never)), "unknown_provider");
  assert.equal(code(port.logout({ providerId: "anthropic" as never })), "unknown_provider");
});

test("a duplicate (providerId, accountId, scope) login is refused", async () => {
  const port = makePort();
  await ok(port.login({ providerId: "fixture", accountId: "acct-1" }));
  assert.equal(code(port.login({ providerId: "fixture", accountId: "acct-1" })), "duplicate_account");
});

// --- status / list / exportPublic carry no secret ---------------------------

test("status, list and exportPublic never carry a secret (adversarial #1)", async () => {
  const port = makePort();
  const secret = "sk-live-do-not-leak-000111222333";

  await ok(port.login({ providerId: "openai-compatible", secret, label: "work" }));

  const status = await ok(port.status());
  const list = await ok(port.list());
  const publicView = await ok(port.exportPublic());

  for (const rendered of [JSON.stringify(status), JSON.stringify(list), JSON.stringify(publicView)]) {
    assert.equal(rendered.includes(secret), false);
  }
});

test("status reports one row per provider with the resolving layer", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", secret: "sk-secret" }));
  const status = await ok(port.status());

  assert.deepEqual(status.map((row) => row.providerId), ["openai-compatible", "fixture"]);
  assert.equal(status[0]?.loggedIn, true);
  assert.equal(status[0]?.layer, "user");
  assert.equal(status[1]?.loggedIn, false);
  assert.equal(status[1]?.layer, "none");
});

// --- switch / delete / logout ----------------------------------------------

test("switch moves only the named provider's pointer (adversarial #11)", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-b", secret: "sk-b" }));
  await ok(port.login({ providerId: "fixture", accountId: "fx-1" }));

  await ok(port.switch({ providerId: "openai-compatible", accountId: "acct-a", scope: "user" }));

  const openai = await ok(port.get("openai-compatible"));

  assert.equal(openai.accountId, "acct-a");
  const fixture = await ok(port.get("fixture"));

  assert.equal(fixture.accountId, "fx-1");
});

test("switch to an unknown account fails and leaves the pointer alone", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  assert.equal(
    code(port.switch({ providerId: "openai-compatible", accountId: "acct-zzz", scope: "user" })),
    "unknown_account",
  );
  const resolved = await ok(port.get("openai-compatible"));

  assert.equal(resolved.accountId, "acct-a");
});

test("deleting the current account is refused (adversarial #4)", async () => {
  const port = makePort();
  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  assert.equal(
    code(port.delete({ providerId: "openai-compatible", accountId: "acct-a", scope: "user" })),
    "current_account_protected",
  );
});

test("deleting a non-current account succeeds once switched away", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-b", secret: "sk-b" }));
  // acct-b is current; acct-a can be deleted.
  const deleted = await ok(
    port.delete({ providerId: "openai-compatible", accountId: "acct-a", scope: "user" }),
  );

  assert.equal(deleted.accountId, "acct-a");
  const remaining = await ok(port.list());

  assert.deepEqual(
    remaining.map((entry) => entry.accountId),
    ["acct-b"],
  );
});

test("logout clears only the pointer and keeps every record", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  await ok(port.logout({ providerId: "openai-compatible", scope: "user" }));
  const resolved = await ok(port.get("openai-compatible"));

  assert.equal(resolved.layer, "none");
  const entries = await ok(port.list());

  assert.deepEqual(
    entries.map((entry) => entry.accountId),
    ["acct-a"],
  );
});

test("logout with no scope clears both scopes and is idempotent", async () => {
  const port = makePort({ hasProject: true });

  await ok(port.login({ providerId: "fixture", accountId: "u-1", scope: "user" }));
  await ok(port.login({ providerId: "fixture", accountId: "p-1", scope: "project" }));
  await ok(port.logout({ providerId: "fixture" }));
  assert.equal((await ok(port.get("fixture"))).layer, "none");
  // A second logout is still ok — already logged out is not an error.
  const again = await ok(port.logout({ providerId: "fixture" }));

  assert.equal(Array.isArray(again), true);
});

test("list isCurrent agrees with status after a switch (adversarial #11)", async () => {
  const port = makePort();

  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-a", secret: "sk-a" }));
  await ok(port.login({ providerId: "openai-compatible", accountId: "acct-b", secret: "sk-b" }));
  await ok(port.switch({ providerId: "openai-compatible", accountId: "acct-a", scope: "user" }));

  const entries = await ok(port.list());
  const current = entries.filter((entry) => entry.isCurrent).map((entry) => entry.accountId);

  assert.deepEqual(current, ["acct-a"]);
  const status = await ok(port.status());

  assert.equal(status.find((row) => row.providerId === "openai-compatible")?.accountId, "acct-a");
});

// --- exportSecrets gate -----------------------------------------------------

test("exportSecrets without confirm:true is refused (adversarial #8)", () => {
  const port = makePort();
  assert.equal(code(port.exportSecrets({ confirm: false })), "confirm_required");
});

test("exportSecrets with confirm:true returns records including secrets", async () => {
  const port = makePort();
  await ok(port.login({ providerId: "openai-compatible", secret: "sk-secret" }));
  const view = await ok(port.exportSecrets({ confirm: true }));
  assert.equal(view.records.length, 1);
  assert.equal(view.records[0]?.secret, "sk-secret");
});
