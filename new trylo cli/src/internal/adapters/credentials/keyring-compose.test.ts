import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialPortPreferringKeyring } from "./keyring-compose.js";
import { KEYRING_USER_TARGET, type OsKeyringDriver } from "../../credentials/keyring-driver.js";

/**
 * The prefer-keyring selection (WP 三轨 T3 §5 acceptance #1).
 *
 * Two states, decided at selection time — before any secret exists:
 *
 *  - **probe available** → the keyring store backs the port and the report says
 *    which driver won;
 *  - **probe unavailable** → the port degrades to the file ledger *with a
 *    stated reason* (`fallback: true`), which the wiring layer turns into one
 *    `warning` — never a silent downgrade, never an error.
 *
 * What must NOT happen here (proven by the store suite): an operation-time
 * keyring failure falling back to a file. Degradation is a probe-time decision
 * only.
 */

const NOW = "2026-09-16T09:30:00.000Z";
const SECRET = "sk-keyring-compose-test-171717";

function fakeDriver(availability: { available: true } | { available: false; reason: string }): OsKeyringDriver & {
  readonly blobs: Map<string, string>;
} {
  const blobs = new Map<string, string>();
  return {
    id: "fake-keyring",
    blobs,
    probe: () => availability,
    read: (target) => blobs.get(target),
    write: (target, blob) => {
      blobs.set(target, blob);
    },
    remove: (target) => {
      blobs.delete(target);
    },
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "trylo-keyring-compose-"));
}

test("an available keyring backs the port, and the report names the driver", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = fakeDriver({ available: true });
  const composed = createCredentialPortPreferringKeyring({ homeDir: home, now: () => NOW, driver });

  assert.deepEqual(composed.report, { backend: "os-keyring", driverId: "fake-keyring" });
  assert.equal(composed.port.login({ providerId: "openai-compatible", secret: SECRET }).ok, true);
  const resolved = composed.port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.secret : "", SECRET);
  // The secret lives in the keyring blob, not in a file under home.
  assert.equal(existsSync(join(home, "credentials.json")), false);
  assert.equal(driver.blobs.get(KEYRING_USER_TARGET)?.includes(SECRET), true);
});

test("an unavailable keyring degrades to the file ledger with a stated reason", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const driver = fakeDriver({ available: false, reason: "no keyring on this machine" });
  const composed = createCredentialPortPreferringKeyring({ homeDir: home, now: () => NOW, driver });

  assert.equal(composed.report.backend, "file");
  assert.equal(composed.report.backend === "file" ? composed.report.fallback : false, true);
  assert.equal(
    composed.report.backend === "file" ? composed.report.reason : "",
    "no keyring on this machine",
  );

  // The degraded port is an ordinary file-backed port.
  assert.equal(composed.port.login({ providerId: "openai-compatible", secret: SECRET }).ok, true);
  const resolved = composed.port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.secret : "", SECRET);
  const ledger = readFileSync(join(home, "credentials.json"), "utf8");

  assert.equal(ledger.includes(SECRET), true);
});

test("neither report shape ever carries a secret", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const available = createCredentialPortPreferringKeyring({
    homeDir: home,
    now: () => NOW,
    driver: fakeDriver({ available: true }),
  });

  assert.equal(JSON.stringify(available.report).includes(SECRET), false);
  const degraded = createCredentialPortPreferringKeyring({
    homeDir: home,
    now: () => NOW,
    driver: fakeDriver({ available: false, reason: "down" }),
  });

  assert.equal(JSON.stringify(degraded.report).includes(SECRET), false);
});
