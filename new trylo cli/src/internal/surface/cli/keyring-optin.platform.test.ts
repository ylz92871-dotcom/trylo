import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsCredentialManagerDriver } from "../../adapters/credentials/windows/keyring-win32.js";
import { keyringTarget } from "../../credentials/keyring-driver.js";
import type { CredentialPort, CredentialProviderId } from "../../ports/credentials.js";
import {
  createCliCredentialPortWithReport,
  type CredentialWiringContext,
} from "./credentials-wiring.js";
import { tryloHome } from "./session-paths.js";

/**
 * Live Windows Credential Manager round trip through the opt-in wiring.
 *
 * This platform test runs under `test:platform` (on Windows jobs with an active logon session).
 */

const SECRET = "sk-keyring-optin-secret-246813579";
const OTHER_SECRET = "sk-keyring-optin-other-135792468";
const IS_WIN32 = process.platform === "win32";

type TempRoot = { readonly home: string; readonly cwd: string; readonly cleanup: () => void };

function tempRoot(): TempRoot {
  const root = mkdtempSync(join(tmpdir(), "trylo-optin-platform-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function ctxOf(env: Readonly<Record<string, string | undefined>>, root: TempRoot): CredentialWiringContext {
  return { homeDir: root.home, cwd: root.cwd, env, now: () => 0 };
}

function ledgerFile(root: TempRoot, env: Readonly<Record<string, string | undefined>>): string {
  return join(tryloHome(root.home, env), "credentials.json");
}

function secretOf(port: CredentialPort, providerId: CredentialProviderId): string | undefined {
  const resolved = port.get(providerId);
  return resolved.ok ? resolved.value.secret : undefined;
}

function credentialManagerTargets(): readonly string[] {
  const result = spawnSync("cmdkey", ["/list"], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  return text
    .split(/\r?\n/)
    .filter((line) => /trylo:/i.test(line) && !/trylo:test:/i.test(line))
    .map((line) => line.trim())
    .sort();
}

test("a real Credential Manager round trip through the opt-in wiring leaves no trace", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  const driver = createWindowsCredentialManagerDriver();
  if (!driver.probe().available) {
    return t.skip("no live Credential Manager on this machine");
  }

  const root = tempRoot();

  t.after(root.cleanup);
  const before = credentialManagerTargets();
  const located = keyringTarget("project", root.cwd);

  assert.equal(located.ok, true);
  const target = located.ok ? located.target : "";

  t.after(() => {
    try {
      driver.remove(target);
    } catch {
      // Best effort; the before/after assertion below is the real check.
    }
  });

  const env = { TRYLO_PREFER_KEYRING: "1" };
  const collected: Array<{ readonly code: string }> = [];
  const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => collected.push(w));

  assert.deepEqual(collected, [], "a live Credential Manager is not a degradation");
  const login = port.login({ providerId: "openai-compatible", scope: "project", accountId: "acct", secret: SECRET });

  assert.equal(login.ok, true, login.ok ? "" : `login failed: ${login.code}: ${login.detail}`);
  assert.equal(existsSync(ledgerFile(root, env)), false, "the file ledger must stay untouched");
  assert.equal(secretOf(port, "openai-compatible"), SECRET, "the secret must round-trip through Credential Manager");

  const second = port.login({
    providerId: "openai-compatible",
    scope: "project",
    accountId: "acct-2",
    secret: OTHER_SECRET,
  });

  assert.equal(second.ok, true);
  assert.equal(secretOf(port, "openai-compatible"), OTHER_SECRET);

  driver.remove(target);
  assert.equal(driver.read(target), undefined, "the project entry must be gone");
  assert.deepEqual(credentialManagerTargets(), before, "the round trip left entries behind");
});
