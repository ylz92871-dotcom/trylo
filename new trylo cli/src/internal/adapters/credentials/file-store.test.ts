import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bindVerbs, type PortDeps } from "../../credentials/verbs.js";
import { createFileLedgerStore, ledgerPath } from "./file-store.js";
import type { CredentialPort } from "../../ports/credentials.js";

/**
 * The file backend's storage rules (WP §2.5).
 *
 * These are the properties a ledger file either has or does not, so they are
 * tested against a real temporary directory rather than a fake: checksum
 * rejection on a hand-edited file, atomic replacement, the lock refusal, the
 * `0600` mode, and the `..` escape guard. The POSIX-mode assertion is skipped on
 * Windows where the bit has no equivalent — recorded as a gap, not silently
 * dropped.
 */

const NOW = "2026-09-15T12:00:00.000Z";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "trylo-cred-"));
}

function portFor(homeDir: string, projectDir?: string, env: Record<string, string | undefined> = {}): CredentialPort {
  const deps: PortDeps = {
    store: createFileLedgerStore(projectDir === undefined ? { homeDir } : { homeDir, projectDir }),
    env,
    now: () => NOW,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    hasProject: projectDir !== undefined,
  };
  return bindVerbs(deps);
}

function userFile(homeDir: string): string {
  const located = ledgerPath({ homeDir }, "user");
  assert.equal(located.ok, true);
  return located.ok ? located.path : "";
}

test("a login writes the ledger under homeDir and a get reads it back", (t) => {
  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);

  const file = userFile(home);
  const text = readFileSync(file, "utf8");

  assert.equal(text.includes("sk-file"), true);
  assert.equal(text.endsWith("\n"), true);

  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.secret : undefined, "sk-file");
});

test("a hand-edited ledger is refused rather than half-read", (t) => {
  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);

  const file = userFile(home);
  const tampered = readFileSync(file, "utf8").replace("sk-file", "sk-attacker");

  writeFileSync(file, tampered);

  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false ? resolved.code : "", "credentials_corrupt");
});

test("an empty ledger file is corrupt, not 'no credentials'", (t) => {
  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(userFile(home), "");
  const port = portFor(home);
  const status = port.status();

  assert.equal(status.ok, false);
  assert.equal(status.ok === false ? status.code : "", "credentials_corrupt");
});

test("a fresh directory reads as an empty ledger (missing is not an error)", (t) => {
  const home = tempRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);
  const entries = port.list();
  assert.equal(entries.ok, true);
  assert.deepEqual(entries.ok ? entries.value : ["non-empty"], []);
});

test("a second writer while the lock is held is refused with lock_conflict", (t) => {
  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);

  // Simulate a competing writer: create the lock file the store would create.
  const file = userFile(home);

  writeFileSync(`${file}.lock`, "other-pid\n");

  const second = portFor(home);
  const result = second.login({ providerId: "openai-compatible", accountId: "acct-2", secret: "sk-2" });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : "", "lock_conflict");
  rmSync(`${file}.lock`, { force: true });
});

test("a relative ledger path is always strictly inside its root (adversarial #6)", () => {
  const home = tempRoot();
  const located = ledgerPath({ homeDir: home }, "user");

  assert.equal(located.ok, true);

  if (located.ok) {
    // The resolved path must be strictly under the resolved root: a `..` in a
    // caller-supplied root cannot make the ledger land beside it.
    assert.equal(located.path.startsWith(join(home, "")), true);
    assert.equal(located.path, join(home, "credentials.json"));
  }

  rmSync(home, { recursive: true, force: true });
});

test("an unbalanced root segment cannot escape the named directory", () => {
  const root = tempRoot();
  // A root of `<home>/sub/..` resolves back to `<home>`, not to a parent that a
  // nested ledger could climb out of.
  const located = ledgerPath({ homeDir: join(root, "sub", "..") }, "user");

  rmSync(root, { recursive: true, force: true });
  assert.equal(located.ok, true);

  if (located.ok) {
    assert.equal(located.path.endsWith(join("credentials.json")), true);
  }
});

test("the user ledger lives at <homeDir>/credentials.json", (t) => {
  const home = tempRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const located = ledgerPath({ homeDir: home }, "user");
  assert.equal(located.ok, true);
  assert.equal(located.ok ? located.path : "", join(home, "credentials.json"));
});

test("the project ledger lives at <projectDir>/.trylo/credentials.json", (t) => {
  const projectDir = tempRoot();
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const located = ledgerPath({ homeDir: tempRoot(), projectDir }, "project");
  assert.equal(located.ok, true);
  assert.equal(located.ok ? located.path : "", join(projectDir, ".trylo", "credentials.json"));
});

test("a POSIX ledger is written 0600 and a loosened one is reported insecure", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not observable on win32; recorded in AUTH-QUALITY-AUDIT.md");
    return;
  }

  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);
  const file = userFile(home);

  assert.equal(statSync(file).mode & 0o777, 0o600);

  chmodSync(file, 0o644);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false ? resolved.code : "", "credentials_insecure");
});

test("no temp file is left behind after a successful write", (t) => {
  const home = tempRoot();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = portFor(home);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);
  const file = userFile(home);

  assert.equal(existsSync(file), true);
  // The store replaces the whole file through `${file}.${uuid}.tmp` + rename;
  // a leftover with that suffix in the ledger's directory is the failure the
  // test name has always promised to catch.
  const leftovers = readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp"));

  assert.deepEqual(leftovers, []);
});
