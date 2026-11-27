import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWindowsIsolation } from "./windows/windows-isolation.js";
import type { VendorWindowsApi } from "./sandbox-vendor.js";
import { prepareWindowsIsolation } from "./windows/windows-readiness.js";

test("readiness consumes the mapped vendor contract and its successful behavioural verification", { skip: process.platform !== "win32" }, async () => {
  let verified = 0;
  const vendorApi = {
    checkWindowsSandboxStatusAsync: async () => ({ user: { provisioned: true, credPresent: true }, wfp: { state: "cannot-read" } }),
    verifyWindowsWfpEgress: async () => {
      verified += 1;
      return { target: "127.0.0.1:45678", stderr: "BLOCKED" };
    },
    getWindowsSandboxUserStatusAsync: async () => ({ sid: "S-1-5-21-123-1007" }),
    grantWindowsAcl: () => {},
    revokeWindowsAcl: () => [],
    SRT_WIN_DISPATCH_ARG1: "--srt-win",
  };
  const config = { helperPath: process.execPath, readableExecutable: () => false, vendorApi };
  const availability = await createWindowsIsolation(config).probe();

  assert.equal(availability.state, "ready");
  assert.equal(verified, 1, "non-elevated enumeration must still verify the actual fence");
});

function privateInstallApi(events: string[], failProbe = false, failCleanup = false): VendorWindowsApi {
  let readable = false;
  return {
    SRT_WIN_DISPATCH_ARG1: "--srt-win",
    checkWindowsSandboxStatusAsync: async () => ({ user: { provisioned: true, credPresent: true }, wfp: { state: "installed" } }),
    getWindowsSandboxUserStatusAsync: async () => ({ sid: "S-1-5-21-123-1007" }),
    grantWindowsAcl: ({ read, write }) => {
      if (read.length > 0) {
        readable = true;
        events.push("helper-read");
      }
      if (write.length > 0) events.push("workspace-write");
    },
    verifyWindowsWfpEgress: async () => {
      events.push("wfp");
      assert.equal(readable, true, "private helper must be readable before its restricted-logon WFP probe");
      if (failProbe) throw new Error("fence inactive");
      return { target: "127.0.0.1:45678", stderr: "BLOCKED" };
    },
    revokeWindowsAcl: () => {
      events.push("revoke");
      return failCleanup ? undefined : [];
    },
  };
}

test("private-install readiness bootstraps helper read and releases the same owner", { skip: process.platform !== "win32" }, async () => {
  const events: string[] = [];
  const availability = await createWindowsIsolation({ helperPath: process.execPath, readableExecutable: () => false, vendorApi: privateInstallApi(events) }).probe();
  assert.equal(availability.state, "ready");
  assert.deepEqual(events, ["helper-read", "wfp", "revoke"]);
});

test("failed readiness compensates bootstrap read without a workspace write grant", { skip: process.platform !== "win32" }, async () => {
  const events: string[] = [];
  const availability = await createWindowsIsolation({ helperPath: process.execPath, readableExecutable: () => false, vendorApi: privateInstallApi(events, true) }).probe();
  assert.equal(availability.state, "broken");
  assert.deepEqual(events, ["helper-read", "wfp", "revoke"]);
});

test("execution holds the same bootstrap lease and grants writes only after proof", { skip: process.platform !== "win32" }, async () => {
  const events: string[] = [];
  const prepared = await prepareWindowsIsolation([process.cwd()], { helperPath: process.execPath, readableExecutable: () => false, vendorApi: privateInstallApi(events) });

  assert.equal(prepared.availability.state, "ready");
  assert.deepEqual(events, ["helper-read", "wfp", "workspace-write"]);
  assert.ok(prepared.lease);
  prepared.lease.close();
  prepared.lease.close();
  assert.deepEqual(events, ["helper-read", "wfp", "workspace-write", "revoke"]);
});

test("cancellation during readiness releases bootstrap and never launches a child", { skip: process.platform !== "win32" }, async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const api = privateInstallApi(events);
  const vendorApi = { ...api, verifyWindowsWfpEgress: async () => {
    const proof = await api.verifyWindowsWfpEgress({});
    controller.abort();
    return proof;
  } };
  const outcome = await createWindowsIsolation({ helperPath: process.execPath, readableExecutable: () => false, vendorApi }).run({
    argv: [process.execPath, "-e", "throw new Error('must not launch')"], cwd: process.cwd(),
    files: { writableRoots: [process.cwd()], denyReadPaths: [], denyWritePaths: [] },
    network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: false }, timeoutMs: 1000, signal: controller.signal,
  });

  assert.equal(outcome.outcome, "cancelled");
  assert.deepEqual(events, ["helper-read", "wfp", "revoke"]);
});

test("cancellation during final executable ACL inspection prevents spawn and releases the proven lease", { skip: process.platform !== "win32" }, async t => {
  const controller = new AbortController(), events: string[] = [];
  const directory = mkdtempSync(path.join(tmpdir(), "trylo-cancel-after-acl-"));
  const target = path.join(directory, "never-executed.bin");

  writeFileSync(target, "fixed test target; must never be spawned");
  const actualTarget = realpathSync.native(target);
  let spawns = 0;

  t.mock.method(childProcess, "spawn", () => {
    spawns += 1;
    throw new Error("cancelled execution must not spawn");
  });
  syncBuiltinESMExports();

  try {
    const outcome = await createWindowsIsolation({ helperPath: process.execPath, vendorApi: privateInstallApi(events),
      readableExecutable(program) {
        if (program === actualTarget) {
          events.push("target-inspection");
          controller.abort();
          return true;
        }
        return false;
      } }).run({ argv: [target], cwd: directory,
      files: { writableRoots: [], denyReadPaths: [], denyWritePaths: [] },
      network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: false }, timeoutMs: 1000, signal: controller.signal });

    assert.equal(outcome.outcome, "cancelled", JSON.stringify({ outcome, events, spawns }));
    assert.equal(spawns, 0, "even a subsequently cancelled child is an unauthorized late launch");
    assert.deepEqual(events, ["helper-read", "wfp", "target-inspection", "revoke"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

// An intentionally unconfirmed revoke keeps this process's owner busy; run it last.
test("readiness cannot conceal failed bootstrap compensation", { skip: process.platform !== "win32" }, async () => {
  const events: string[] = [];
  const availability = await createWindowsIsolation({ helperPath: process.execPath, readableExecutable: () => false, vendorApi: privateInstallApi(events, true, true) }).probe();

  assert.equal(availability.state, "broken");

  if (availability.state === "broken") {
    assert.match(availability.reason, /isolation_cleanup_failed/);
    assert.match(availability.reason, /fence inactive/);
    assert.match(availability.reason, /ACL revocation was missing/);
  }
});
