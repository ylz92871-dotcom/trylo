// WCC-P2-05: pinned native WGC helper supply chain (spec §19.8).
//
// The helper is native code the capture path executes. The invariants
// pinned here:
//  - the manifest pins ONE helper build (digest + size + protocol version);
//  - the resolver's lookup order is env override → packaged staging →
//    dev publish output, and a PRESENT-but-drifted artifact is refused
//    (digest_mismatch), never passed to the capture path;
//  - a missing artifact resolves as not_staged — the capture path then
//    degrades to the honest legacy status (§13.1), never a download.
//  - the release inventory gates the same digest.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WINDOWS_MCP_MANIFEST } from '../../src/tooling/manifests/windows-mcp.mjs';
import {
  resolvePinnedWgcHelper,
  WGC_HELPER_DEV_SRC,
} from '../../src/tooling/tool-package-manager.mjs';

const HELPER = WINDOWS_MCP_MANIFEST.helper;

function writeFakeHelper(dir, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, HELPER.executableRelativePath);
  fs.writeFileSync(exe, Buffer.from(bytes));
  return exe;
}

test('the manifest pins exactly one WGC helper build', () => {
  assert.equal(HELPER.kind, 'dotnet-single-file');
  assert.equal(HELPER.protocolVersion, 1);
  assert.match(HELPER.sha256, /^[0-9a-f]{64}$/);
  // The pinned artifact is the 42 MB single-file self-contained publish.
  assert.equal(HELPER.sizeBytes, 42067483);
  assert.equal(HELPER.executableRelativePath, 'trylo-wgc-helper.exe');
  assert.equal(HELPER.packagedDirName, 'wgc-helper');
  assert.equal(
    HELPER.sourceTree,
    'new_tool/computer-control/Windows-MCP/native/wgc-helper',
  );
});

test('resolvePinnedWgcHelper prefers the env override and verifies its digest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-helper-'));
  try {
    const drift = writeFakeHelper(dir, 'tampered');
    const drifted = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST, {
      env: { WINDOWS_MCP_WGC_HELPER: drift },
    });
    // Present but not the pinned build → refused, not passed through.
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reasonCode, 'digest_mismatch');
    assert.equal(drifted.path, drift);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePinnedWgcHelper returns not_staged when nothing exists', async () => {
  const resolved = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST, {
    env: { WINDOWS_MCP_WGC_HELPER: '' },
    // No dev publish output on this fake tree: point every candidate at a
    // nonexistent root via the existsSync seam.
    existsSync: () => false,
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reasonCode, 'not_staged');
  assert.equal(resolved.path, null);
});

test('resolvePinnedWgcHelper: a missing override falls through the chain (not_staged when nothing matches)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-helper-'));
  try {
    // The override points at a file that does not exist; no other candidate
    // matches the existsSync seam either, so the walk must end in
    // not_staged — a missing override never resolves to a guess.
    const resolved = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST, {
      env: { WINDOWS_MCP_WGC_HELPER: path.join(dir, 'missing.exe') },
      existsSync: () => false,
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reasonCode, 'not_staged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePinnedWgcHelper digest-verifies the first chain candidate that exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-helper-'));
  try {
    // The override DOES exist but carries the wrong bytes: the digest gate
    // fires on the first found candidate, wherever it came from.
    const drifted = writeFakeHelper(dir, 'not the pinned build');
    const resolved = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST, {
      env: { WINDOWS_MCP_WGC_HELPER: drifted },
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reasonCode, 'digest_mismatch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePinnedWgcHelper without a manifest only checks presence (test seam)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-helper-'));
  try {
    const exe = writeFakeHelper(dir, 'whatever');
    const resolved = await resolvePinnedWgcHelper(null, {
      env: { WINDOWS_MCP_WGC_HELPER: exe },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.path, exe);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dev publish output on THIS checkout matches the pinned digest', async () => {
  // Live gate: when the checkout has the publish output, the resolver must
  // find exactly that artifact and its digest must satisfy the pin. On a
  // machine without the build, resolvePinnedWgcHelper falls through its
  // candidates and reports not_staged — that degradation is what we assert.
  const resolved = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST, {
    env: { WINDOWS_MCP_WGC_HELPER: '' },
  });
  const devPublish = path.resolve(
    WGC_HELPER_DEV_SRC,
    HELPER.executableRelativePath,
  );
  if (!fs.existsSync(devPublish)) {
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reasonCode, 'not_staged');
    return;
  }
  assert.equal(resolved.ok, true, `dev publish digest drift: ${JSON.stringify(resolved)}`);
  assert.equal(path.resolve(resolved.path), devPublish);
});
