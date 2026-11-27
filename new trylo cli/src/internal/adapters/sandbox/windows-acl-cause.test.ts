import assert from "node:assert/strict";
import test from "node:test";
import { acquireWindowsAclLease } from "./windows/windows-acl-lease.js";
import type { VendorWindowsApi } from "./sandbox-vendor.js";

test("failed grant compensation preserves the native permission cause as well as cleanup failure", async () => {
  const api: VendorWindowsApi = {
    checkWindowsSandboxStatusAsync: async () => ({}),
    getWindowsSandboxUserStatusAsync: async () => ({ sid: "S-1-5-21-123-1007" }),
    verifyWindowsWfpEgress: async () => ({ target: "fixture", stderr: "" }),
    grantWindowsAcl: () => { throw new Error("open .acl-init.lock: access denied (os error 5)"); },
    revokeWindowsAcl: () => undefined,
    SRT_WIN_DISPATCH_ARG1: "--srt-win",
  };
  await assert.rejects(acquireWindowsAclLease([], { exe: "unused", prependArgs: [] }, api), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /isolation_cleanup_failed/);
    assert.match(error.message, /\.acl-init\.lock: access denied/);
    assert.match(error.message, /ACL revocation was missing/);
    assert.equal(error.errors.length, 2);
    return true;
  });
});
