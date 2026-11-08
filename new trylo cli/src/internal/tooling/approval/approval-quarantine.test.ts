import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryPermissionStore, type MemoryPermissionStore } from "../../adapters/permission-store/index.js";
import { acquireToQuarantine } from "../../learning/agent/subsystems/tool/adapters/quarantine/acquire.js";
import { inspectArchive } from "../../learning/agent/subsystems/tool/assets/quarantine/archive-guard.js";
import { archive, issuedGrantRef, manifest, provenance } from "../testing/fixtures.js";
import { consumeApproval } from "./gates.js";

const NOW = "2026-09-12T00:00:00Z";
const GRANT_FACTS = {
  candidateId: "cand-mit",
  packageVersionId: "pkg:pdf-lint:1.0.0",
  scope: "docs",
};

test("acquire without an injected port neither consumes nor writes quarantine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-qd-"));
  try {
    const result = await acquireToQuarantine({
      token: { grantId: "grant:unused" },
      now: NOW,
      ...GRANT_FACTS,
      quarantineRoot: root,
      archive: archive(),
      compressedBytes: 32,
      manifest: manifest(),
      provenance: provenance(),
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "no_port");
    }

    const names = await readdir(root);

    assert.deepEqual(names, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquire without a token has no quarantine writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-qd-notoken-"));
  try {
    const result = await acquireToQuarantine({
      approvalPort: createMemoryPermissionStore(),
      now: NOW,
      ...GRANT_FACTS,
      quarantineRoot: root,
      archive: archive(),
      compressedBytes: 32,
      manifest: manifest(),
      provenance: provenance(),
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "missing_token");
    }

    const names = await readdir(root);

    assert.deepEqual(names, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grants cannot cross action, version, scope, or be replayed; expiry lives in the store", async () => {
  const store: MemoryPermissionStore = createMemoryPermissionStore();
  const grantRef = await issuedGrantRef(store, "acquire");
  const base = {
    token: grantRef,
    ...GRANT_FACTS,
    now: NOW,
  };
  const noPort = await consumeApproval(undefined, { ...base, action: "acquire" });

  assert.equal(noPort.ok, false);

  if (!noPort.ok) {
    assert.equal(noPort.code, "no_port");
  }

  const wrongAction = await consumeApproval(store, { ...base, action: "activate" });

  assert.equal(wrongAction.ok, false);
  const wrongVersion = await consumeApproval(store, {
    ...base,
    action: "acquire",
    packageVersionId: "pkg:pdf-lint:9.9.9",
  });

  assert.equal(wrongVersion.ok, false);
  const wrongScope = await consumeApproval(store, { ...base, action: "acquire", scope: "shell" });

  assert.equal(wrongScope.ok, false);
  const wrongCandidate = await consumeApproval(store, {
    ...base,
    action: "acquire",
    candidateId: "cand-other",
  });

  assert.equal(wrongCandidate.ok, false);
  const expiredGrant = await store.issue({
    ...GRANT_FACTS,
    action: "acquire",
    issuedAt: "2019-01-01T00:00:00Z",
    expiry: "2020-01-01T00:00:00Z",
  });

  assert.equal(expiredGrant.ok, true);

  if (expiredGrant.ok) {
    const expired = await consumeApproval(store, {
      ...base,
      action: "acquire",
      token: { grantId: expiredGrant.grant.grantId },
    });

    assert.equal(expired.ok, false);

    if (!expired.ok) {
      assert.equal(expired.code, "expired");
    }
  }

  const first = await consumeApproval(store, { ...base, action: "acquire" });

  assert.equal(first.ok, true);
  const replay = await consumeApproval(store, { ...base, action: "acquire" });

  assert.equal(replay.ok, false);

  if (!replay.ok) {
    assert.equal(replay.code, "replayed");
  }
});

test("hash mismatch path traversal symlink zip bomb and postinstall reject", () => {
  assert.equal(inspectArchive(archive({ expectedHash: "a", actualHash: "b" }), 10).ok, false);
  assert.equal(
    inspectArchive(archive({ entries: [{ path: "../etc/passwd", kind: "file", size: 1, content: "x" }] }), 10).ok,
    false,
  );
  assert.equal(
    inspectArchive(
      archive({ entries: [{ path: "link", kind: "symlink", size: 1, linkTarget: "../outside" }] }),
      10,
    ).ok,
    false,
  );
  assert.equal(inspectArchive(archive({ uncompressedBytes: 50_000_000 }), 10).ok, false);
  assert.equal(
    inspectArchive(
      archive({ entries: [{ path: "pkg.json", kind: "file", size: 1, content: "{}", postinstall: true }] }),
      10,
    ).ok,
    false,
  );
});

test("approved acquire writes only inside quarantine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-qd-ok-"));
  try {
    const store = createMemoryPermissionStore();
    const result = await acquireToQuarantine({
      approvalPort: store,
      token: await issuedGrantRef(store, "acquire"),
      now: NOW,
      ...GRANT_FACTS,
      quarantineRoot: root,
      archive: archive(),
      compressedBytes: 32,
      manifest: manifest(),
      provenance: provenance(),
    });

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(result.value.catalogState, "quarantined");
    const names = await readdir(root);

    assert.equal(names.includes("server.mjs"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a port that throws or rejects is normalized into a failed consumption (audit P1-6)", async () => {
  const throwing = {
    consume: async () => {
      throw new Error("unexpected disk explosion");
    },
  };
  const thrown = await consumeApproval(throwing, {
    token: { grantId: "grant:1" },
    action: "acquire",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    scope: "docs",
    now: NOW,
  });

  assert.equal(thrown.ok, false);

  if (!thrown.ok) {
    assert.equal(thrown.code, "ledger_write_failed");
  }

  const rejecting = {
    consume: async () => {
      throw new Error("reject");
    },
  };
  const rejectedPort = await consumeApproval(rejecting, {
    token: { grantId: "grant:1" },
    action: "acquire",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    scope: "docs",
    now: NOW,
  });

  assert.equal(rejectedPort.ok, false);

  if (!rejectedPort.ok) {
    assert.equal(rejectedPort.code, "ledger_write_failed");
  }
});
