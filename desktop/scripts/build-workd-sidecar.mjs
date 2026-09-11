// Trylo Desktop — build the minimal managed-work sidecar release artifact.
//
// Audit P0-C §5.2: the INSTALLED app must run the real workd daemon without
// a source checkout, without npm, and without compiling anything on the user
// machine. This script stages exactly that artifact into
// `desktop/src-tauri/resources/workd/`:
//
//   workd/
//     dist/daemon/**        — the tsc build (`npm run build:daemon` output)
//     node_modules/<pkg>/** — the production dependency closure reachable
//                             from dist/daemon's `require()` graph
//     manifest.json         — build metadata + the native-binding probe result
//
// The better-sqlite3 native binding is PROBED HERE, at build time, with the
// pinned Node runtime that ships next to it (audit: 「better-sqlite3 必须按
// 随包 Node ABI 预构建并在 release gate 强制探测」). A failing probe fails
// the build — never a half-working sidecar.
//
// Usage:
//   node scripts/build-workd-sidecar.mjs            # stage + probe
//   node scripts/build-workd-sidecar.mjs --rebuild  # re-run cowork build:daemon first
//
// Exit codes: 0 = staged + probed OK; 1 = any required piece missing.

import { promises as fsp, existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const vendorRoot = path.join(repoRoot, 'work', 'vendor', 'cowork-os');
const resourcesRoot = path.join(desktopRoot, 'src-tauri', 'resources');
const stageRoot = path.join(resourcesRoot, 'workd');

const REBUILD = process.argv.includes('--rebuild');

/** Packages that must never enter the closure: `electron` is the dev host's
 *  binary (the daemon guards its use — requiring it from plain Node can never
 *  work, so any *load-time* dependency on it would already fail in dev). */
const EXCLUDED_PACKAGES = new Set(['electron', 'electron-devtools-installer']);

// ── helpers ────────────────────────────────────────────────────────────────

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fsp.copyFile(from, to);
  }
}

/** Read `require("pkg/sub")` / `require('@scope/pkg/x')` / dynamic-import
 *  strings out of one JS file. Node builtins are filtered by the caller. */
function collectRequires(source) {
  const out = new Set();
  const re = /require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"'.][^"']*)["']/g;
  let match;
  while ((match = re.exec(source))) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) out.add(spec);
  }
  return out;
}

function packageNameOf(specifier) {
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Resolve a package name inside `vendorRoot/node_modules` (npm flat layout,
 *  plus the package's own nested node_modules as a fallback). */
function packageDirInVendor(pkgName) {
  const flat = path.join(vendorRoot, 'node_modules', pkgName);
  if (fs.existsSync(path.join(flat, 'package.json'))) return flat;
  return null;
}

function isBuiltinSpecifier(specifier) {
  const name = specifier.replace(/\/+$/, '');
  if (!specifier.endsWith('/')) {
    return name.startsWith('node:') || NODE_BUILTINS.has(name);
  }
  // A trailing slash BYPASSES builtin resolution (require('process/') loads
  // the npm `process` package). Only a builtin is safe to skip when the
  // vendor tree does not carry a package of that name; when it does, the
  // code explicitly wants the package.
  return !packageDirInVendor(name) && NODE_BUILTINS.has(name);
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function isBuiltin(name) {
  return NODE_BUILTINS.has(name) || name.startsWith('node:');
}

/** Walk one copied package's JS files and enqueue its own dependencies. */
async function scanPackageForRequires(pkgDir, queue, seen) {
  let entries;
  try {
    entries = await fsp.readdir(pkgDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(pkgDir, entry.name);
    if (entry.isDirectory()) {
      // NESTED node_modules: the packages inside are copied verbatim with
      // their parent, but their own requires must be scanned too — a nested
      // package (e.g. grammy/node_modules/node-fetch) resolves its deps up
      // the tree into the flat vendor root, exactly like the staged tree
      // will. Skipping them leaves that subtree's closure unstaged.
      await scanPackageForRequires(full, queue, seen);
      continue;
    }
    if (!/\.(?:c|m)?js$/.test(entry.name)) continue;
    let source;
    try {
      source = await fsp.readFile(full, 'utf8');
    } catch {
      continue;
    }
    for (const spec of collectRequires(source)) {
      const pkgName = packageNameOf(spec);
      if (!pkgName || isBuiltinSpecifier(spec) || EXCLUDED_PACKAGES.has(pkgName)) continue;
      if (seen.has(pkgName)) continue;
      const dir = packageDirInVendor(pkgName);
      if (!dir) {
        console.warn(`build-workd-sidecar: WARN require('${spec}') not found in vendor node_modules (transitive from ${pkgDir})`);
        continue;
      }
      seen.add(pkgName);
      queue.push({ name: pkgName, dir });
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const daemonMain = path.join(vendorRoot, 'dist', 'daemon', 'daemon', 'main.js');
  if (!existsSync(daemonMain)) {
    if (!REBUILD) {
      console.error('build-workd-sidecar: dist/daemon/daemon/main.js is missing.');
      console.error('  Run `node scripts/build-workd-sidecar.mjs --rebuild` (builds via npm run build:daemon)');
      console.error('  or build cowork-os first (audit §5.2: the BUILD machine builds, never the user machine).');
      process.exit(1);
    }
    console.log('build-workd-sidecar: running cowork build:daemon...');
    execFileSync('npm', ['run', 'build:daemon'], { cwd: vendorRoot, stdio: 'inherit', shell: true });
    if (!existsSync(daemonMain)) {
      console.error('build-workd-sidecar: build:daemon did not produce dist/daemon/daemon/main.js');
      process.exit(1);
    }
  }

  // Fresh stage: a previous tree must never leak into the new artifact.
  await fsp.rm(stageRoot, { recursive: true, force: true });
  await fsp.mkdir(stageRoot, { recursive: true });

  // 1. The built daemon tree.
  console.log('build-workd-sidecar: staging dist/daemon');
  await copyDir(path.join(vendorRoot, 'dist', 'daemon'), path.join(stageRoot, 'dist', 'daemon'));

  // 2. The production dependency closure over the daemon require graph.
  console.log('build-workd-sidecar: tracing the require closure');
  const seen = new Set();
  const queue = [];
  await scanPackageForRequires(path.join(stageRoot, 'dist', 'daemon'), queue, seen);
  let copied = 0;
  while (queue.length > 0) {
    const pkg = queue.shift();
    const dest = path.join(stageRoot, 'node_modules', pkg.name);
    await copyDir(pkg.dir, dest);
    copied += 1;
    // Transitive deps (bin scripts, lazy requires inside the package).
    await scanPackageForRequires(dest, queue, seen);
  }
  console.log(`build-workd-sidecar: staged ${copied} production packages`);

  // 2b. The package manifest. REQUIRED: without a package.json inside the
  // staged tree, Node walks up to `desktop/package.json` ("type":"module")
  // and the CommonJS daemon build dies with "exports is not defined in ES
  // module scope" (found by the sidecar smoke). The vendor manifest has no
  // "type" field → CommonJS-by-default scope, which is what tsc emitted.
  const vendorManifest = JSON.parse(await fsp.readFile(path.join(vendorRoot, 'package.json'), 'utf8'));
  if (vendorManifest.type === 'module') {
    console.error('build-workd-sidecar: vendor manifest declares "type":"module" — the daemon build is CommonJS; refusing to stage a broken scope.');
    process.exit(1);
  }
  delete vendorManifest.scripts; // a user machine must never npm-run anything
  delete vendorManifest.devDependencies;
  await fsp.writeFile(
    path.join(stageRoot, 'package.json'),
    JSON.stringify(vendorManifest, null, 2) + '\n',
    'utf8',
  );

  // 3. Native-binding probe with the pinned Node (§5.2 release gate).
  const nodeCandidates = [
    process.env.TRYLO_NODE_RUNTIME_DIR
      ? path.join(process.env.TRYLO_NODE_RUNTIME_DIR, 'node.exe')
      : null,
    path.join(resourcesRoot, 'runtime', 'node', 'win-x64', 'node.exe'),
    process.execPath,
  ].filter(Boolean);
  const nodeExe = nodeCandidates.find((p) => fs.existsSync(p)) ?? process.execPath;
  const nodeVersion = execFileSync(nodeExe, ['--version']).toString().trim();
  console.log(`build-workd-sidecar: probing better-sqlite3 with ${nodeVersion}`);
  let probeOk = false;
  try {
    execFileSync(
      nodeExe,
      ['-e', "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(a)'); db.close();"],
      { cwd: stageRoot, stdio: 'ignore', shell: false, timeout: 60_000 },
    );
    probeOk = true;
  } catch (error) {
    console.error(`build-workd-sidecar: better-sqlite3 probe FAILED: ${error?.message ?? error}`);
  }
  if (!probeOk) {
    console.error('build-workd-sidecar: the native binding does not load under the pinned Node ABI.');
    console.error('  Rebuild better-sqlite3 for that ABI in the vendor tree, then re-run this script.');
    process.exit(1);
  }

  // 4. Manifest for the release inventory.
  await fsp.writeFile(
    path.join(stageRoot, 'manifest.json'),
    JSON.stringify(
      {
        kind: 'trylo-workd-sidecar',
        builtAt: new Date().toISOString(),
        node: nodeVersion,
        daemonMain: 'dist/daemon/daemon/main.js',
        packages: copied,
        betterSqlite3Probe: probeOk ? 'ok' : 'failed',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`build-workd-sidecar: OK -> ${stageRoot}`);
}

main().catch((error) => {
  console.error('build-workd-sidecar: FAILED:', error?.message ?? error);
  process.exit(1);
});
