import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialPort } from "./compose.js";
import { createMemoryKeyring } from "./memory-keyring.js";

/**
 * The keyring adapter slot (WP §0).
 *
 * A real OS keyring is out of scope, so this suite proves the three properties
 * the WP actually asks for:
 *
 *  - **detached by default** — a port with no keyring selection uses the file
 *    ledger and does *not* report `keyring_unavailable`;
 *  - **attachable** — a login/status/logout cycle works when a keyring store is
 *    wired, and `status` still carries no secret (adversarial #10);
 *  - **fails closed when asked for and missing** — an explicitly-unattached
 *    keyring refuses every operation rather than silently writing a file.
 */

const NOW = "2026-09-15T12:00:00.000Z";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "trylo-keyring-"));
}

test("with no keyring selection the port uses the file ledger (no keyring_unavailable)", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = createCredentialPort({ homeDir: home, now: () => NOW });
  const logged = port.login({ providerId: "openai-compatible", secret: "sk-file-backend" });

  assert.equal(logged.ok, true);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.secret : "", "sk-file-backend");
});

test("an attached keyring carries login/status/logout end to end", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const keyring = createMemoryKeyring();
  const port = createCredentialPort({ homeDir: home, now: () => NOW, keyring: { attached: true, store: keyring.store } });

  const secret = "sk-keyring-secret-999";

  assert.equal(port.login({ providerId: "openai-compatible", secret }).ok, true);

  // status carries no secret (adversarial #10).
  const status = port.status();

  assert.equal(status.ok, true);
  assert.equal(JSON.stringify(status).includes(secret), false);

  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok ? resolved.value.secret : "", secret);

  assert.equal(port.logout({ providerId: "openai-compatible" }).ok, true);
  const after = port.get("openai-compatible");

  assert.equal(after.ok ? after.value.layer : "", "none");
});

test("the keyring path does not touch the home directory", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const keyring = createMemoryKeyring();
  const port = createCredentialPort({ homeDir: home, now: () => NOW, keyring: { attached: true, store: keyring.store } });

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-keyring" }).ok, true);

  // No ledger file was created — the credential lives in the keyring store.
  assert.equal(existsSync(join(home, "credentials.json")), false);
});

test("an explicitly unattached keyring fails closed on every verb", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = createCredentialPort({ homeDir: home, now: () => NOW, keyring: { attached: false } });

  for (const result of [
    port.login({ providerId: "openai-compatible", secret: "sk-x" }),
    port.logout({ providerId: "openai-compatible" }),
    port.status(),
    port.list(),
    port.get("openai-compatible"),
    port.switch({ providerId: "openai-compatible", accountId: "a", scope: "user" }),
    port.delete({ providerId: "openai-compatible", accountId: "a", scope: "user" }),
    port.exportPublic(),
    port.exportSecrets({ confirm: true }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : "", "keyring_unavailable");
  }
});
