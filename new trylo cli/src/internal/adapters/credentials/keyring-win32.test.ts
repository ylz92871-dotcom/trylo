import assert from "node:assert/strict";
import type { SpawnSyncOptions } from "node:child_process";
import test from "node:test";
import {
  createWindowsCredentialManagerDriver,
  type SpawnResult,
  type SpawnSyncImpl,
} from "./windows/keyring-win32.js";

/**
 * Hermetic unit tests for the Windows Credential Manager driver.
 *
 * Uses an injected `SpawnSyncImpl` double so tests run 100% deterministically
 * across all environments without touching the real OS Credential Manager
 * or spawning PowerShell processes. Live platform verification is located in
 * `keyring-win32.platform.test.ts`.
 */

type SpawnCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnSyncOptions;
};

function createMockSpawn(handler: (call: SpawnCall) => SpawnResult): {
  readonly spawnImpl: SpawnSyncImpl;
  readonly calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl: SpawnSyncImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  };

  return { spawnImpl, calls };
}

test("probe returns available true when child returns ok response, and memoizes the result", () => {
  const { spawnImpl, calls } = createMockSpawn(() => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, found: false, blob: "" }),
  }));

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });
  const result1 = driver.probe();

  assert.equal(result1.available, true);
  assert.equal(calls.length, 1);

  // Memoized: second call does not re-invoke spawnImpl
  const result2 = driver.probe();

  assert.equal(result2.available, true);
  assert.equal(calls.length, 1);
});

test("probe returns available false with reason when child fails or produces invalid output", () => {
  const { spawnImpl } = createMockSpawn(() => ({
    status: 1,
    stdout: "",
    error: new Error("powershell not found"),
  }));

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });
  const result = driver.probe();

  assert.equal(result.available, false);

  if (!result.available) {
    assert.match(result.reason, /powershell not found/);
  }
});

test("read decodes base64 blob when found is true", () => {
  const rawSecret = "sk-hermetic-secret-12345";
  const b64 = Buffer.from(rawSecret, "utf8").toString("base64");

  const { spawnImpl, calls } = createMockSpawn((call) => {
    const input = JSON.parse(String(call.options.input));

    assert.equal(input.op, "read");
    assert.equal(input.target, "trylo:credentials:user");

    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, found: true, blob: b64 }),
    };
  });

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });
  const value = driver.read("trylo:credentials:user");

  assert.equal(value, rawSecret);
  assert.equal(calls.length, 1);
});

test("read returns undefined when entry is not found", () => {
  const { spawnImpl } = createMockSpawn(() => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, found: false, blob: "" }),
  }));

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });

  assert.equal(driver.read("trylo:credentials:missing"), undefined);
});

test("write sends base64 encoded blob via stdin and succeeds on ok response", () => {
  const rawDocument = "ledger-content-data";
  let capturedInput = "";

  const { spawnImpl } = createMockSpawn((call) => {
    capturedInput = String(call.options.input);
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, found: false, blob: "" }),
    };
  });

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });

  driver.write("trylo:credentials:target", rawDocument);

  const payload = JSON.parse(capturedInput);

  assert.equal(payload.op, "write");
  assert.equal(payload.target, "trylo:credentials:target");
  assert.equal(Buffer.from(payload.blob, "base64").toString("utf8"), rawDocument);
});

test("write rejects document exceeding 2560 bytes before invoking spawn", () => {
  let spawned = false;
  const { spawnImpl } = createMockSpawn(() => {
    spawned = true;
    return { status: 0, stdout: JSON.stringify({ ok: true, found: false, blob: "" }) };
  });

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });
  const tooLarge = "a".repeat(2561);

  assert.throws(
    () => driver.write("target", tooLarge),
    (err: unknown) => err instanceof Error && err.message.includes("2560"),
  );
  assert.equal(spawned, false, "must not spawn process when exceeding size limit");
});

test("remove sends delete op to child", () => {
  let capturedInput = "";
  const { spawnImpl } = createMockSpawn((call) => {
    capturedInput = String(call.options.input);
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, found: false, blob: "" }),
    };
  });

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });

  driver.remove("trylo:credentials:target");

  const payload = JSON.parse(capturedInput);

  assert.equal(payload.op, "delete");
  assert.equal(payload.target, "trylo:credentials:target");
});

test("secrets never appear in child process command line arguments", () => {
  const secret = "super-secret-token-do-not-leak";
  const { spawnImpl, calls } = createMockSpawn(() => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, found: false, blob: "" }),
  }));

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });

  driver.write("trylo:test", secret);

  assert.equal(calls.length, 1);
  const call = calls[0]!;

  for (const arg of call.args) {
    assert.equal(arg.includes(secret), false, "secret leaked in child arguments");
  }
});

test("backend reporting ok false throws canonical error", () => {
  const { spawnImpl } = createMockSpawn(() => ({
    status: 0,
    stdout: JSON.stringify({ ok: false, error: "Access is denied" }),
  }));

  const driver = createWindowsCredentialManagerDriver({ spawnImpl });

  assert.throws(
    () => driver.read("target"),
    (err: unknown) => err instanceof Error && err.message.includes("keyring backend reported: Access is denied"),
  );
});

test("backend producing empty or unreadable stdout throws error", () => {
  const { spawnImpl: emptySpawn } = createMockSpawn(() => ({ status: 0, stdout: "   " }));
  const driverEmpty = createWindowsCredentialManagerDriver({ spawnImpl: emptySpawn });

  assert.throws(
    () => driverEmpty.read("target"),
    (err: unknown) => err instanceof Error && err.message.includes("produced no output"),
  );

  const { spawnImpl: badJsonSpawn } = createMockSpawn(() => ({ status: 0, stdout: "not-json" }));
  const driverBadJson = createWindowsCredentialManagerDriver({ spawnImpl: badJsonSpawn });

  assert.throws(
    () => driverBadJson.read("target"),
    (err: unknown) => err instanceof Error && err.message.includes("unreadable output"),
  );
});
