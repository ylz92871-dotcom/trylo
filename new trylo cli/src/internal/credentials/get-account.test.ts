import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialPort } from "../adapters/credentials/compose.js";
import type { CredentialPort } from "../ports/credentials.js";

/**
 * `getAccount`: the read a *provider declaration* needs.
 *
 * The whole point of this verb is a sentence that must never become true: an
 * endpoint authenticating with a key that was issued for a different host. So
 * the three assertions that matter are (1) it returns the named account's key,
 * (2) it never moves the family's current pointer, and (3) it never answers with
 * an environment-declared key when a specific account was asked for.
 */

const NOW = "2026-09-25T12:00:00.000Z";

function tempPort(): { readonly port: CredentialPort; readonly home: string } {
  const home = mkdtempSync(join(tmpdir(), "trylo-get-account-"));
  return {
    port: createCredentialPort({ homeDir: home, now: () => NOW }),
    home,
  };
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

test("getAccount returns the named account and leaves the current pointer alone", () => {
  const { port, home } = tempPort();
  try {
    assert.equal(
      port.login({ providerId: "openai-compatible", accountId: "work", secret: "work-key" }).ok,
      true,
    );
    assert.equal(
      port.login({ providerId: "openai-compatible", accountId: "personal", secret: "personal-key" }).ok,
      true,
    );
    // The second login moved the current pointer to `personal`.

    const named = port.getAccount({ providerId: "openai-compatible", accountId: "work" });

    assert.equal(named.ok, true);

    if (named.ok) {
      assert.equal(named.value.accountId, "work");
      assert.equal(named.value.secret, "work-key");
      assert.equal(named.value.layer, "user");
    }

    // And the pointer is exactly where the last login left it: a read of a
    // named account never moved it.
    const current = port.get("openai-compatible");

    assert.equal(current.ok, true);

    if (current.ok) {
      assert.equal(current.value.accountId, "personal");
    }
  } finally {
    cleanup(home);
  }
});

test("an env declaration is never the answer to a named account", () => {
  // The account is stored first, and the environment variable is declared for
  // the *second* port over the same profile — which is the real-world order:
  // the key was in the ledger, then someone exported one into the shell. A
  // `login` under that variable is refused (`env_shadowed`), which is why the
  // store happens first.
  const home = mkdtempSync(join(tmpdir(), "trylo-get-account-"));
  try {
    assert.equal(
      createCredentialPort({ homeDir: home, now: () => NOW })
        .login({ providerId: "openai-compatible", accountId: "work", secret: "work-key" }).ok,
      true,
    );
    const port = createCredentialPort({
      homeDir: home,
      env: { TRYLO_OPENAI_API_KEY: "env-key" },
      now: () => NOW,
    });
    // `get` resolves the environment variable; the named account must not.
    const viaGet = port.get("openai-compatible");

    assert.equal(viaGet.ok && viaGet.value.layer === "env", true);
    const named = port.getAccount({ providerId: "openai-compatible", accountId: "work" });

    assert.equal(named.ok, true);

    if (named.ok) {
      assert.equal(named.value.secret, "work-key");
      assert.equal(named.value.layer, "user");
    }
  } finally {
    cleanup(home);
  }
});

test("a typo is unknown_account with the ids that do exist", () => {
  const { port, home } = tempPort();
  try {
    assert.equal(
      port.login({ providerId: "openai-compatible", accountId: "work", secret: "work-key" }).ok,
      true,
    );
    const miss = port.getAccount({ providerId: "openai-compatible", accountId: "wrk" });

    assert.equal(miss.ok, false);

    if (!miss.ok) {
      assert.equal(miss.code, "unknown_account");
      assert.match(miss.detail, /known accounts: work/);
    }

    // An account for a *different* provider is not one for this one.
    const other = port.getAccount({ providerId: "fixture", accountId: "work" });

    assert.equal(other.ok, false);
  } finally {
    cleanup(home);
  }
});
