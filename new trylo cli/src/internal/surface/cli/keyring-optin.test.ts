import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KEYRING_USER_TARGET, type OsKeyringDriver } from "../../credentials/keyring-driver.js";
import type { CredentialPort, CredentialProviderId } from "../../ports/credentials.js";
import {
  createCliCredentialPort,
  createCliCredentialPortWithReport,
  type CredentialWiringContext,
} from "./credentials-wiring.js";
import { tryloHome } from "./session-paths.js";

/**
 * The opt-in keyring wiring (WP `2026-09-16-WP-传统CLI-交付面收尾波` §4 轨 W-KEY).
 *
 * The contract these tests exist for is the *zero-diff* one: with the switch off
 * (`TRYLO_PREFER_KEYRING` absent, or anything but the exact string `"1"`) the
 * binding must be the plain file ledger, byte for byte, and no keyring driver
 * may be reached at all. A driver double whose every method throws is how that
 * last claim is made falsifiable rather than read off the source.
 *
 * The switch-on cases run against an injected driver. The genuine Windows
 * Credential Manager round trip is separated into `keyring-optin.platform.test.ts`.
 */

const SECRET = "sk-keyring-optin-secret-246813579";

type TempRoot = { readonly home: string; readonly cwd: string; readonly cleanup: () => void };

function tempRoot(): TempRoot {
  const root = mkdtempSync(join(tmpdir(), "trylo-optin-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fixed clock keeps the written document deterministic, so "byte for byte" is checkable. */
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

type SpyDriver = OsKeyringDriver & {
  readonly blobs: Map<string, string>;
  readonly probes: () => number;
};

function spyDriver(availability: { available: true } | { available: false; reason: string }): SpyDriver {
  const blobs = new Map<string, string>();
  let probes = 0;

  return {
    id: "spy-keyring",
    blobs,
    probes: () => probes,

    probe: () => {
      probes += 1;
      return availability;
    },

    read: (target) => blobs.get(target),
    write: (target, blob) => {
      blobs.set(target, blob);
    },
    remove: (target) => {
      blobs.delete(target);
    },
  };
}

/** Every method throws: if the default path reaches a driver, the test fails loudly. */
function explodingDriver(): SpyDriver {
  const boom = (): never => {
    throw new Error("the default path must not reach a keyring driver");
  };
  return {
    id: "exploding",
    blobs: new Map(),
    probes: () => 0,
    probe: boom,
    read: boom,
    write: boom,
    remove: boom,
  };
}

test("the switch is a closed set of one: only the exact string \"1\" turns it on", (t) => {
  for (const value of ["", "0", "true", "on", "yes", "TRUE", "True", "1 ", " 1", "01", "1.0"]) {
    const root = tempRoot();

    t.after(root.cleanup);
    const driver = spyDriver({ available: true });
    const collected: Array<{ readonly code: string }> = [];
    const env = { TRYLO_PREFER_KEYRING: value };

    const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => collected.push(w), { driver });

    assert.equal(driver.probes(), 0, `value ${JSON.stringify(value)} probed the keyring`);
    assert.equal(collected.length, 0, `value ${JSON.stringify(value)} reported a fallback`);
    // And the port is the file binding, not "the prefer path that fell back".
    assert.equal(port.login({ providerId: "openai-compatible", accountId: "acct", secret: SECRET }).ok, true);
    assert.equal(readFileSync(ledgerFile(root, env), "utf8").includes(SECRET), true);
  }

  const root = tempRoot();

  t.after(root.cleanup);
  const on = spyDriver({ available: true });

  createCliCredentialPortWithReport(ctxOf({ TRYLO_PREFER_KEYRING: "1" }, root), () => {}, { driver: on });
  assert.equal(on.probes(), 1, 'the exact string "1" must probe the keyring');
});

test("with the switch off the reporting binding is the plain one: same bytes, no probe", (t) => {
  const plain = tempRoot();
  const reported = tempRoot();

  t.after(plain.cleanup);
  t.after(reported.cleanup);
  const login = { providerId: "openai-compatible" as const, accountId: "acct-1", secret: SECRET };

  assert.equal(createCliCredentialPort(ctxOf({}, plain)).login(login).ok, true);

  const collected: Array<{ readonly code: string }> = [];
  const reportedPort = createCliCredentialPortWithReport(ctxOf({}, reported), (w) => collected.push(w), {
    driver: explodingDriver(),
  });

  assert.equal(reportedPort.login(login).ok, true);

  assert.equal(readFileSync(ledgerFile(reported, {}), "utf8"), readFileSync(ledgerFile(plain, {}), "utf8"));
  assert.equal(collected.length, 0);
});

test("with the switch on and no keyring the ledger is still the file, plus exactly one warning", (t) => {
  const root = tempRoot();

  t.after(root.cleanup);
  const env = { TRYLO_PREFER_KEYRING: "1" };
  const collected: Array<{ readonly code: string; readonly message: string }> = [];

  const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => collected.push(w), {
    driver: spyDriver({ available: false, reason: "no keyring on this machine" }),
  });

  assert.equal(collected.length, 1, "a degradation is reported exactly once");
  assert.equal(collected[0]?.code, "keyring_unavailable_fallback");
  assert.equal(collected[0]?.message, "no keyring on this machine");
  // The command itself still works, against the file ledger.
  assert.equal(port.login({ providerId: "openai-compatible", accountId: "acct", secret: SECRET }).ok, true);
  assert.equal(readFileSync(ledgerFile(root, env), "utf8").includes(SECRET), true);
});

test("with the switch on and a keyring the secret lands in the keyring, not in a file", (t) => {
  const root = tempRoot();

  t.after(root.cleanup);
  const env = { TRYLO_PREFER_KEYRING: "1" };
  const driver = spyDriver({ available: true });
  const collected: Array<{ readonly code: string }> = [];

  const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => collected.push(w), { driver });

  assert.equal(port.login({ providerId: "openai-compatible", accountId: "acct", secret: SECRET }).ok, true);

  assert.equal(collected.length, 0, "an available keyring is not a degradation");
  assert.equal(driver.blobs.get(KEYRING_USER_TARGET)?.includes(SECRET), true);
  assert.equal(existsSync(ledgerFile(root, env)), false, "the file ledger must not receive a new secret");
  assert.equal(secretOf(port, "openai-compatible"), SECRET);
});

test("a file credential written before opt-in stays readable after it (read order)", (t) => {
  const root = tempRoot();

  t.after(root.cleanup);
  const env = { TRYLO_PREFER_KEYRING: "1" };

  // The user's credential already exists, in the file ledger, from before the switch.
  assert.equal(
    createCliCredentialPort(ctxOf(env, root)).login({
      providerId: "openai-compatible",
      accountId: "old",
      secret: SECRET,
    }).ok,
    true,
  );

  const driver = spyDriver({ available: true });
  const seen: string[] = [];
  const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => seen.push(w.code), { driver });

  // The keyring has never stored anything, so the file copy is still the answer.
  assert.equal(secretOf(port, "openai-compatible"), SECRET);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok && resolved.value.accountId, "old");
  assert.deepEqual(seen, [], "reading an old credential is not a degradation");
  assert.equal(driver.blobs.size, 0, "a read must not write anything into the keyring");
});

test("the warning a degradation emits never carries the secret", (t) => {
  const root = tempRoot();

  t.after(root.cleanup);
  const env = { TRYLO_PREFER_KEYRING: "1" };
  const collected: Array<{ readonly code: string; readonly message: string }> = [];

  const port = createCliCredentialPortWithReport(ctxOf(env, root), (w) => collected.push(w), {
    driver: spyDriver({ available: false, reason: "the platform driver reported no store" }),
  });

  port.login({ providerId: "openai-compatible", accountId: "acct", secret: SECRET });

  assert.equal(collected.length, 1);
  assert.equal(JSON.stringify(collected).includes(SECRET), false);
  assert.equal(JSON.stringify(collected).includes("acct"), false, "the report is about the machine, not the account");
});

test("every production call site binds the reporting factory, so no degradation is silent", () => {
  // The reporting binding is worthless if a command keeps calling the plain one:
  // the warning channel would exist and nobody would ever pass it. This is the
  // reachability half of the change, checked the way the sibling suite checks
  // that no CLI file reaches `exportSecrets`.
  const cliDir = join(process.cwd(), "src", "internal", "surface", "cli");

  // `run-command.ts` no longer resolves the credential itself: a run now asks
  // for one by *family* (`provider-selection.ts`), because a declared provider
  // is not an account. The contract travels with the call site — every
  // production site still binds the reporting factory — so the list below names
  // where the calls actually are, not where they used to be.
  for (const file of ["commands-auth.ts", "doctor.ts", "provider-selection.ts"]) {
    const text = readFileSync(join(cliDir, file), "utf8");
    assert.equal(text.includes("createCliCredentialPortWithReport"), true, `${file} still binds the plain factory`);
    assert.equal(text.includes("createCliCredentialPort(ctx)"), false, `${file} still calls the plain factory`);
  }

  // `commands.ts` no longer builds doctor's IO itself: `/doctor` inside a REPL
  // needed the same facts, so the construction moved to `doctor-run.ts` and
  // both call it. The binding is still a production fact — it is checked where
  // it now lives, because checking the file the call *used* to be in is how a
  // binding silently disappears.
  const run = readFileSync(join(cliDir, "doctor-run.ts"), "utf8");

  assert.equal(
    /warn:\s*credentialWarningTo\(ctx\)/.test(run),
    true,
    "doctor-run.ts must feed doctor's warning channel, or doctor's fallback is silent",
  );
});

