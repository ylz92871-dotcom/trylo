import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOsKeyringLedgerStore } from "./keyring-store.js";
import { createCredentialPort } from "./compose.js";
import { KEYRING_USER_TARGET, type OsKeyringDriver } from "../../credentials/keyring-driver.js";

/**
 * The keyring-backed `LedgerStore` against a fake driver.
 *
 * The fake answers the question the real driver cannot answer in a unit test:
 * what happens when the backing store is missing, corrupt, or failing. The
 * document codec, the scope mapping and the failure mapping (fail closed, never
 * a silent file fallback) are the code under test here; the real driver's
 * behaviour is proven separately against the live Credential Manager.
 */

const NOW = "2026-09-16T09:00:00.000Z";
const SECRET = "sk-keyring-store-test-424242";

type FakeCall = { readonly op: "read" | "write" | "remove"; readonly target: string };

type FakeDriver = OsKeyringDriver & {
  readonly blobs: Map<string, string>;
  readonly calls: FakeCall[];
};

function createFakeDriver(options?: {
  readonly failRead?: Error;
  readonly failWrite?: Error;
}): FakeDriver {
  const blobs = new Map<string, string>();
  const calls: FakeCall[] = [];

  return {
    id: "fake-keyring",
    blobs,
    calls,
    probe: () => ({ available: true }),
    read: (target) => {
      calls.push({ op: "read", target });
      if (options?.failRead !== undefined) {
        throw options.failRead;
      }
      return blobs.get(target);
    },
    write: (target, blob) => {
      calls.push({ op: "write", target });
      if (options?.failWrite !== undefined) {
        throw options.failWrite;
      }
      blobs.set(target, blob);
    },
    remove: (target) => {
      calls.push({ op: "remove", target });
      blobs.delete(target);
    },
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "trylo-keyring-store-"));
}

test("a login/get/logout cycle rides the keyring store end to end", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver();
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });

  assert.equal(port.login({ providerId: "openai-compatible", secret: SECRET }).ok, true);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.secret : "", SECRET);
  assert.equal(port.logout({ providerId: "openai-compatible" }).ok, true);
  const after = port.get("openai-compatible");

  assert.equal(after.ok ? after.value.layer : "", "none");

  // The user-scope write went to the one fixed target.
  const targets = driver.calls.filter((call) => call.op === "write").map((call) => call.target);

  assert.deepEqual([...new Set(targets)], [KEYRING_USER_TARGET]);
});

test("an empty keyring is a miss, not a failure (NoEntry => Ok(None))", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver();
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.layer : "", "none");
});

test("a corrupt keyring entry is refused whole (fail closed, like the file backend)", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver();

  driver.blobs.set(KEYRING_USER_TARGET, "{ not a ledger document");
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false ? resolved.code : "", "credentials_corrupt");
});

test("a keyring read failure is read_failed, never a silent file fallback", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver({ failRead: new Error("cm busted") });
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false ? resolved.code : "", "read_failed");
  // The failure detail names the driver error, not the secret.
  assert.equal(resolved.ok === false ? resolved.detail.includes("cm busted") : false, true);
  assert.equal(existsSync(join(home, "credentials.json")), false);
});

test("a keyring write failure is write_failed and stores nothing anywhere", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver({ failWrite: new Error("cm full") });
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });
  const logged = port.login({ providerId: "openai-compatible", secret: SECRET });

  assert.equal(logged.ok, false);
  assert.equal(logged.ok === false ? logged.code : "", "write_failed");
  assert.equal(existsSync(join(home, "credentials.json")), false);
});

test("the keyring path does not touch the home directory", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver();
  const port = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-keyring" }).ok, true);
  assert.equal(existsSync(join(home, "credentials.json")), false);
});

test("project scopes are namespaced per workspace, and absent projectDir is path_escape", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = createFakeDriver();
  const alpha = createCredentialPort({
    homeDir: home,
    projectDir: "C:\\workspaces\\alpha",
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver, projectDir: "C:\\workspaces\\alpha" }) },
  });
  const beta = createCredentialPort({
    homeDir: home,
    projectDir: "C:\\workspaces\\beta",
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver, projectDir: "C:\\workspaces\\beta" }) },
  });

  assert.equal(alpha.login({ providerId: "openai-compatible", secret: "sk-alpha", scope: "project" }).ok, true);
  const seen = new Set(driver.calls.filter((call) => call.op === "write").map((call) => call.target));

  assert.equal(seen.has(KEYRING_USER_TARGET), false);
  assert.equal(seen.size, 1);

  // Beta's project ledger does not see alpha's credential: its project target
  // is a different keyring entry.
  const betaResolved = beta.get("openai-compatible");

  assert.equal(betaResolved.ok, true);
  assert.equal(betaResolved.ok ? betaResolved.value.layer : "", "none");

  // No project directory configured: the same refusal the file backend gives.
  const orphan = createCredentialPort({
    homeDir: home,
    now: () => NOW,
    keyring: { attached: true, store: createOsKeyringLedgerStore({ driver }) },
  });
  const denied = orphan.login({ providerId: "openai-compatible", secret: "sk-x", scope: "project" });

  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false ? denied.code : "", "path_escape");
});
