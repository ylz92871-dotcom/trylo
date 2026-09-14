// Trylo Desktop Services — release inventory check. See migration spec §9.2.
//
// Verifies the presence and SHA-256 of the files the packaged app depends on,
// and prints a manifest. Default mode resolves everything relative to the
// desktop-services package (dev layout). After packaging, point TRYLO_RESOURCE_DIR
// at the bundled `src-tauri/resources/` (or the installed resources dir) to
// verify the shipped artifact instead.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WINDOWS_MCP_MANIFEST } from '../src/tooling/manifests/windows-mcp.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');
const packagedResourceRoot = process.env.TRYLO_RESOURCE_DIR
  ? path.resolve(process.env.TRYLO_RESOURCE_DIR)
  : null;
const serviceRoot = packagedResourceRoot
  ? path.join(packagedResourceRoot, 'desktop-services')
  : packageRoot;
const sidecarsRoot = process.env.TRYLO_SIDECARS_DIR
  ? path.resolve(process.env.TRYLO_SIDECARS_DIR)
  : packagedResourceRoot
    ? path.join(packagedResourceRoot, 'sidecars')
    : path.join(repoRoot, 'desktop', 'sidecars');
/// Where `app.path().resource_dir()` points — the root that holds the
/// pinned Node runtime and the Work wrapper. In dev that is
/// `desktop/src-tauri`, which legitimately has no staged Node, so the
/// packaging-only items are advisory there and REQUIRED when we are
/// verifying a real resources tree.
const resourceRoot = packagedResourceRoot ?? path.join(repoRoot, 'desktop', 'src-tauri');
const verifyingPackaged = Boolean(packagedResourceRoot);

/// Relative paths that may hold the pinned Node runtime, mirroring
/// `node_runtime_candidates()` in `desktop/src-tauri/src/commands/node_runtime.rs`.
/// Only the host triple's entry ships; the generic one exists so a maintainer
/// can stage a runtime without matching the triple exactly.
const NODE_RUNTIME_CANDIDATES =
  process.platform === 'win32'
    ? ['runtime/node/win-x64/node.exe', 'runtime/node/node.exe']
    : process.platform === 'darwin'
      ? [
          'runtime/node/darwin-arm64/bin/node',
          'runtime/node/darwin-x64/bin/node',
          'runtime/node/node',
        ]
      : [
          'runtime/node/linux-x64/bin/node',
          'runtime/node/linux-arm64/bin/node',
          'runtime/node/node',
        ];

const sha256 = async (p) => {
  const data = await fs.readFile(p);
  return crypto.createHash('sha256').update(data).digest('hex');
};

// (label, expectedPath, isRequired)
async function checkItem(label, p, isRequired) {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return { label, path: p, ok: false, error: 'not a file' };
    const hash = await sha256(p);
    return { label, path: p, ok: true, sha: hash, size: stat.size };
  } catch {
    return { label, path: p, ok: false, error: 'missing', required: isRequired };
  }
}

/// WCC-P2-05 (spec §19.8): the pinned .NET WGC capture helper. Presence AND
/// digest are verified against the manifest — the helper is native code the
/// capture path would execute, so a drifted artifact must fail the release
/// gate rather than ship.
///
/// Resolution mirrors the runtime lookup (resolvePinnedWgcHelper):
///   1. packaged tree — `<serviceRoot>/wgc-helper/trylo-wgc-helper.exe`
///      (staged by prepare-sidecars.ps1); required when gating a package;
///   2. dev/CI — the monorepo checkout's `dotnet publish` output; REQUIRED
///      when that build exists (it is the artifact a package would stage),
///      advisory `warn` on a clean checkout with no dotnet build.
async function checkWgcHelper() {
  const helper = WINDOWS_MCP_MANIFEST.helper;
  const packaged = await checkItem(
    'pinned WGC helper (staged)',
    path.join(serviceRoot, helper.packagedDirName, helper.executableRelativePath),
    verifyingPackaged,
  );
  if (packaged.ok || packaged.error !== 'missing') {
    return { ...packaged, label: 'pinned WGC helper' };
  }
  const devPublishPath = path.join(
    repoRoot,
    helper.sourceTree,
    'bin/Release/net8.0-windows10.0.19041.0/win-x64/publish',
    helper.executableRelativePath,
  );
  const dev = await checkItem('pinned WGC helper (dev publish)', devPublishPath, false);
  if (dev.ok || dev.error !== 'missing') {
    // Digest/size still gate the dev artifact — a stale rebuild must fail.
    if (dev.ok && dev.sha !== helper.sha256) {
      return { ...dev, label: 'pinned WGC helper', required: true, ok: false, error: `digest drift (${dev.sha.slice(0, 12)} != pinned ${helper.sha256.slice(0, 12)})` };
    }
    if (dev.ok && dev.size !== helper.sizeBytes) {
      return { ...dev, label: 'pinned WGC helper', required: true, ok: false, error: `size drift (${dev.size} != pinned ${helper.sizeBytes})` };
    }
    return { ...dev, label: 'pinned WGC helper' };
  }
  // Neither location has the artifact. Required only for a packaged tree.
  return {
    label: 'pinned WGC helper',
    path: packaged.path,
    ok: false,
    error: 'missing (not staged and no dev publish output)',
    required: verifyingPackaged,
  };
}

/// Check "any one of these paths exists". Used for the Node runtime, which
/// has a per-triple layout.
async function checkAny(label, root, relatives, isRequired) {
  let last = null;
  for (const relative of relatives) {
    const result = await checkItem(label, path.join(root, relative), isRequired);
    if (result.ok) return { ...result, path: path.join(root, relative) };
    last = result;
  }
  return { ...last, error: `missing (tried ${relatives.join(', ')})`, required: isRequired };
}

async function checkBundleParity(packagedBundle) {
  const sourceBundle = path.join(packageRoot, 'dist', 'host.bundle.mjs');
  try {
    const [packagedSha, sourceSha] = await Promise.all([sha256(packagedBundle), sha256(sourceBundle)]);
    if (packagedSha !== sourceSha) {
      return {
        label: 'service-host source/resource parity',
        path: packagedBundle,
        ok: false,
        error: `stale resource bundle (${packagedSha.slice(0, 12)} != ${sourceSha.slice(0, 12)})`,
        required: true,
      };
    }
    const stat = await fs.stat(packagedBundle);
    return { label: 'service-host source/resource parity', path: packagedBundle, ok: true, sha: packagedSha, size: stat.size };
  } catch {
    return { label: 'service-host source/resource parity', path: packagedBundle, ok: false, error: 'bundle missing', required: true };
  }
}

async function main() {
  const packagedBundle = path.join(serviceRoot, 'dist', 'host.bundle.mjs');
  const items = [
    await checkItem('service-host bundle', packagedBundle, true),
    ...(verifyingPackaged ? [await checkBundleParity(packagedBundle)] : []),
    await checkItem(
      'Windows-MCP Trylo fork',
      path.join(serviceRoot, 'windows-mcp-fork', 'tools', 'ocr.py'),
      verifyingPackaged,
    ),
    // WCC-P2-05: the pinned .NET WGC helper, digest-gated (spec §19.8).
    await checkWgcHelper(),
    await checkItem('vendor desktop companion bridge', path.join(serviceRoot, 'vendor', 'legacy', 'desktop-companion-bridge.js'), true),
    await checkItem('vendor Hermes capability manager', path.join(serviceRoot, 'vendor', 'legacy', 'hermes-capability-manager.js'), true),
    await checkItem('vendor Hermes session sync', path.join(serviceRoot, 'vendor', 'legacy', 'hermes-session-sync.js'), true),
    await checkItem('vendor remote gateway', path.join(serviceRoot, 'vendor', 'legacy', 'remote-gateway', 'index.js'), true),
    await checkItem('vendor remote tunnel', path.join(serviceRoot, 'vendor', 'legacy', 'remote-tunnel.js'), true),
    // ws is a RUNTIME dependency of the vendored remote-gateway (loaded via
    // createRequire from vendor, not through the esbuild bundle). It ships as
    // node_modules/ws next to vendor (spec §9.1 / §3.3) — required whenever
    // we are gating a packaged tree.
    await checkItem(
      'ws runtime package',
      path.join(serviceRoot, 'node_modules', 'ws', 'package.json'),
      verifyingPackaged,
    ),
    await checkItem('desktop pet executable', path.join(sidecarsRoot, 'desktop-companion', 'publish', 'TryloDesktopPet.exe'), true),
    await checkItem('Hermes server', path.join(sidecarsRoot, 'hermes-capabilities', 'server.py'), true),
    await checkItem('Hermes dependency lock', path.join(sidecarsRoot, 'hermes-capabilities', 'requirements.lock'), true),
    // Phase 3 read-only Skills adapter (desktop-services/src/learning/skills-client.mjs
    // spawns it; a missing file degrades the Learning UI, not Code/Work).
    await checkItem('Hermes skills adapter', path.join(sidecarsRoot, 'hermes-capabilities', 'skills_adapter.py'), true),
    // Audit §3.3 — the Work daemon wrapper. Without it `workd.start` cannot
    // spawn at all, and the failure used to surface only as a raw ENOENT.
    await checkItem(
      'Work daemon wrapper',
      path.join(resourceRoot, 'work', 'bin', 'trylo-workd.mjs'),
      verifyingPackaged,
    ),
    // Audit P0-C §5.2 — the minimal managed-work sidecar release artifact.
    // The installed app launches `workd/dist/daemon/daemon/main.js` under
    // the pinned Node; npm/build/rebuild never run on the user machine.
    // REQUIRED when gating a packaged resources tree.
    await checkItem(
      'workd daemon main (packaged sidecar)',
      path.join(resourceRoot, 'workd', 'dist', 'daemon', 'daemon', 'main.js'),
      verifyingPackaged,
    ),
    await checkItem(
      'workd sidecar manifest',
      path.join(resourceRoot, 'workd', 'manifest.json'),
      verifyingPackaged,
    ),
    await checkItem(
      'workd better-sqlite3 package',
      path.join(resourceRoot, 'workd', 'node_modules', 'better-sqlite3', 'package.json'),
      verifyingPackaged,
    ),
    // The prebuilt native binding for the bundled Node ABI. A missing
    // binding means the daemon would die on first DB open — audit §5.2
    // forces the probe at build time and the presence here. better-sqlite3
    // v12 ships node-gyp-build prebuilds (prebuilds/<triple>.node); older
    // layouts used build/Release.
    await checkAny(
      'workd better-sqlite3 native binding',
      path.join(resourceRoot, 'workd', 'node_modules', 'better-sqlite3'),
      ['prebuilds/win32-x64.node', 'build/Release/better_sqlite3.node'],
      verifyingPackaged,
    ),
    await checkItem(
      'workd ws package',
      path.join(resourceRoot, 'workd', 'node_modules', 'ws', 'package.json'),
      verifyingPackaged,
    ),
    // The CoWork runtime the wrapper drives in `real` mode (§7.3).
    // ADVISORY even when packaged: `workd_spawn` defaults to `stub`, and the
    // vendor checkout is >1 GB, so it is staged by a dedicated packaging job
    // rather than by `prepare-sidecars.ps1`. A wrapper without this runtime
    // fails fast in real mode with a reason code — it does not hang.
    await checkAny(
      'CoWork runtime entrypoint (real mode only)',
      resourceRoot,
      [
        path.join('work', 'vendor', 'cowork-os', 'bin', 'coworkd-node.js'),
        path.join('work', 'vendor', 'cowork-os', 'bin', 'coworkd.js'),
      ],
      false,
    ),
    // The pinned Node runtime. The installed app must never depend on
    // `node` being on the system PATH (audit §2.3 Task W4).
    await checkAny('pinned Node runtime', resourceRoot, NODE_RUNTIME_CANDIDATES, verifyingPackaged),
  ];

  const failures = items.filter((i) => !i.ok);
  const present = items.filter((i) => i.ok);
  const requiredMissing = failures.filter((i) => i.required);

  const rows = items.map((i) =>
    i.ok
      ? `OK   ${i.label.padEnd(58)} ${i.sha.slice(0, 16)}  (${i.size} B)`
      : `${i.required ? 'MISS' : 'warn'} ${i.label.padEnd(58)} ${i.error}${i.required ? ' (REQUIRED)' : ''}`,
  );
  console.log('Trylo Desktop Services — release inventory');
  console.log(
    verifyingPackaged
      ? `mode: PACKAGED (resources=${packagedResourceRoot}) — all items required`
      : 'mode: DEV (set TRYLO_RESOURCE_DIR to gate a real resources tree) — packaging-only items are advisory',
  );
  console.log('─────────────────────────────────────────────');
  for (const r of rows) console.log(r);
  console.log(`\npresent: ${present.length} / ${items.length}; required-missing: ${requiredMissing.length}`);

  if (requiredMissing.length > 0) {
    console.error('\nrelease-inventory: FAILED (required artifact missing)');
    process.exit(1);
  }
  console.log('release-inventory: OK');
}

main();
