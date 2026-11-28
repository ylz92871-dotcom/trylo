import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireAclRelease } from "./windows/windows-acl-lease.js";
import { acquireAclOwner } from "./windows/windows-acl-owner.js";

test("ACL teardown rejects anomalous and malformed per-path results", () => {
  for (const result of [undefined, null, {}, [{ path: "C:/work", status: "failed" }], [{ status: "revoked" }]]) {
    assert.throws(() => requireAclRelease(result), /isolation_cleanup_failed/);
  }
  requireAclRelease([]);
  requireAclRelease(["revoked", "stillHeld", "restored", "alreadyOriginal"].map(status => ({ path: "C:/work", status })));
});

test("a second PID-scoped lease cannot revoke the first owner's grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "trylo-acl-owner-"));
  try {
    const release = acquireAclOwner(dir, 123);
    assert.throws(() => acquireAclOwner(dir, 123), /isolation_owner_busy/);
    release();
    acquireAclOwner(dir, 123)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
