import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import test from "node:test";
import {
  createWindowsCredentialManagerDriver,
  type SpawnSyncImpl,
} from "./windows/keyring-win32.js";
import { sealDocument } from "../../credentials/document.js";

/**
 * The Windows Credential Manager driver against the *live* Credential Manager
 * (the track's "real socket" requirement, WP 三轨 T3 §5 acceptance analog of a
 * genuine round trip).
 *
 * This platform test runs under `test:platform` (on Windows jobs with an active logon session).
 * Everything runs under `trylo:test:*` target names and is removed after each
 * test; nothing under `trylo:credentials:*` (production) is touched. The suite
 * skips itself on any platform without PowerShell.
 */

const IS_WIN32 = process.platform === "win32";
const ROUNDTRIP_TARGET = "trylo:test:credentials:roundtrip";
const SPY_TARGET = "trylo:test:credentials:spy";
const NEVER_TARGET = "trylo:test:credentials:never";
const SECRET = "sk-win32-roundtrip-secret-9876543210";

function realisticDocument(): string {
  const body = {
    formatVersion: 1 as const,
    current: { "openai-compatible": "acct-1" },
    records: [
      {
        formatVersion: 1 as const,
        providerId: "openai-compatible" as const,
        accountId: "acct-1",
        label: "test",
        secret: SECRET,
        createdAt: "2026-09-16T09:00:00.000Z",
        updatedAt: "2026-09-16T09:00:00.000Z",
      },
    ],
  };
  return JSON.stringify(sealDocument(body), null, 2) + "\n";
}

function spySpawn(seen: Array<readonly string[]>): SpawnSyncImpl {
  return (command: string, args: readonly string[], options: SpawnSyncOptions) => {
    seen.push(args);
    const result = spawnSync(command, args, options);

    return {
      status: result.status,
      ...(result.error === undefined ? {} : { error: result.error }),
      stdout: result.stdout.toString("utf8"),
    };
  };
}

function cleanup(targets: readonly string[]): void {
  const driver = createWindowsCredentialManagerDriver();
  for (const target of targets) {
    try {
      driver.remove(target);
    } catch {
      // Best effort; a leftover test entry under trylo:test:* is harmless.
    }
  }
}

test("probe reports the live Credential Manager as available", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  const driver = createWindowsCredentialManagerDriver();
  const availability = driver.probe();

  assert.equal(availability.available, true);
  // Memoized: a second probe answers without running the stack again.
  assert.equal(driver.probe(), availability);
});

test("write then read round-trips a whole ledger document through Credential Manager", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  t.after(() => cleanup([ROUNDTRIP_TARGET]));
  const driver = createWindowsCredentialManagerDriver();
  const document = realisticDocument();

  driver.write(ROUNDTRIP_TARGET, document);
  const read = driver.read(ROUNDTRIP_TARGET);

  assert.equal(read, document);
  assert.equal(read?.includes(SECRET), true);
});

test("reading a target that was never stored is undefined, not an error", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }
  const driver = createWindowsCredentialManagerDriver();
  assert.equal(driver.read(NEVER_TARGET), undefined);
});

test("remove clears the entry, and removing a missing entry is not an error", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  t.after(() => cleanup([ROUNDTRIP_TARGET]));
  const driver = createWindowsCredentialManagerDriver();

  driver.write(ROUNDTRIP_TARGET, realisticDocument());
  driver.remove(ROUNDTRIP_TARGET);
  assert.equal(driver.read(ROUNDTRIP_TARGET), undefined);
  driver.remove(ROUNDTRIP_TARGET);
});

test("a document above the 2560-byte Credential Manager blob limit is refused before spawn", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  const driver = createWindowsCredentialManagerDriver();
  const tooLarge = "a".repeat(2561);

  assert.throws(() => driver.write(NEVER_TARGET, tooLarge), (error: unknown) => {
    return error instanceof Error && error.message.includes("2560");
  });
});

test("the secret never appears in the child process argv", (t) => {
  if (!IS_WIN32) {
    return t.skip("win32 only");
  }

  t.after(() => cleanup([SPY_TARGET]));
  const seen: Array<readonly string[]> = [];
  const driver = createWindowsCredentialManagerDriver({ spawnImpl: spySpawn(seen) });

  driver.write(SPY_TARGET, realisticDocument());
  assert.equal(driver.read(SPY_TARGET)?.includes(SECRET), true);

  assert.equal(seen.length >= 2, true);

  for (const args of seen) {
    // argv = [flags..., "-EncodedCommand", base64 of the static script].
    assert.equal(args.includes("-EncodedCommand"), true);

    for (const argument of args) {
      assert.equal(argument.includes(SECRET), false, "secret leaked into argv");
    }

    const encoded = args[args.length - 1] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf16le");

    assert.equal(script.includes(SECRET), false, "secret leaked into the script text");
  }
});
