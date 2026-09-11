#!/usr/bin/env node
// Trylo Work daemon entry. See ../../README.md and ../../STRUCTURE.md.
//
// Phase 1: chooses between two run modes via the TRYLO_WORKD_MODE env var:
//
//   stub (default)   — in-process HTTP server, no coworker deps needed.
//                       Used for Phase 0/1 POC integration tests.
//                       Source: the existing stub below this file's exec.
//
//   real             — shells out to vendor/cowork-os/bin/coworkd-node.js
//                       which builds and runs CoWork-OS's full agent
//                       daemon (Control Plane, MCP, Skills, Memory, DB,
//                       artifact generation). Requires the user to have
//                       run `npm install` in vendor/cowork-os/ first.
//
// The Tauri `workd_spawn` command never has to know which mode is active
// — the binary's contract (HTTP /health endpoint on a port) is identical
// in both modes. The renderer just calls fetch().

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vendorRoot = resolve(__dirname, '..', 'vendor', 'cowork-os');
const mode = (process.env.TRYLO_WORKD_MODE ?? 'stub').toLowerCase();

if (mode === 'real') {
  // ── Real daemon ──────────────────────────────────────────────────────
  // Two layouts, one contract (audit §5.1/§5.2):
  //
  //   PACKAGED (installed app): the sidecar release artifact staged by
  //   `desktop/scripts/build-workd-sidecar.mjs` — a built dist/daemon +
  //   its production node_modules closure. Launching it NEVER runs npm,
  //   never rebuilds anything: the child is
  //   `<packagedRoot>/dist/daemon/daemon/main.js` under the pinned Node
  //   (process.execPath), cwd = <packagedRoot>.
  //
  //   DEV CHECKOUT: delegate to vendor/cowork-os/bin/coworkd-node.js, which
  //   builds + rebuilds as needed (source installs only). Requires the
  //   vendor checkout with node_modules.
  //
  // cowork reads `COWORK_CONTROL_PLANE_HOST` / `COWORK_CONTROL_PLANE_PORT`
  // for its WebSocket bind, and `COWORK_CONTROL_PLANE_ALLOWED_ORIGINS`
  // (comma-separated) for its WebSocket origin check. Desktop supplies a
  // per-launch credential; standalone dev starts still receive a strong
  // random token so production posture checks never leave the wrapper
  // alive without a listening Control Plane.
  const controlPlaneToken = process.env.COWORK_CONTROL_PLANE_TOKEN ?? randomBytes(32).toString('hex');
  const coworkEnv = {
    ...process.env,
    COWORK_CONTROL_PLANE_HOST: process.env.TRYLO_WORKD_HOST ?? '127.0.0.1',
    COWORK_CONTROL_PLANE_PORT: process.env.TRYLO_WORKD_PORT ?? '47821',
    COWORK_CONTROL_PLANE_ALLOWED_ORIGINS: [
      'http://localhost:1420',
      'tauri://localhost',
      'https://tauri.localhost',
    ].join(','),
    COWORK_CONTROL_PLANE_TOKEN: controlPlaneToken,
    // Startup import must be non-destructive.  `overwrite` rewrites the whole
    // provider record on every launch and can erase provider-specific settings
    // that Trylo does not put in env (custom headers, routing profiles, etc.).
    // The renderer calls llm.configure before every send, so changed primary
    // credentials are still applied authoritatively after the socket connects.
    COWORK_IMPORT_ENV_SETTINGS_MODE: 'merge',
  };

  // PACKAGED: `<resource>/work/bin/trylo-workd.mjs` → `<resource>/workd/`.
  // TRYLO_WORKD_PACKAGED_DIR overrides (tests / nonstandard layouts).
  const packagedCandidates = [
    ...(process.env.TRYLO_WORKD_PACKAGED_DIR ? [process.env.TRYLO_WORKD_PACKAGED_DIR] : []),
    resolve(__dirname, '..', '..', 'workd'),
  ];
  const packagedRoot = packagedCandidates.find(
    (dir) => existsSync(join(dir, 'dist', 'daemon', 'daemon', 'main.js')),
  );
  if (packagedRoot) {
    const daemonMain = join(packagedRoot, 'dist', 'daemon', 'daemon', 'main.js');
    // The shim's own defaults (coworkd-node.js): headless + Control Plane +
    // env-settings import. No npm, no build, no rebuild — the artifact is
    // prebuilt (§5.2).
    const daemonArgs = [
      '--headless',
      '--enable-control-plane',
      '--import-env-settings',
      ...process.argv.slice(2),
    ];
    const child = spawn(process.execPath, [daemonMain, ...daemonArgs], {
      cwd: packagedRoot,
      stdio: 'inherit',
      env: coworkEnv,
    });
    child.on('close', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error('[trylo-workd] failed to spawn the packaged daemon:', err);
      process.exit(1);
    });
  } else {
    // DEV CHECKOUT: the vendor shim owns deps/build/rebuild for source
    // installs. On an installed app reaching this branch the release chain
    // is broken — fail with the layout that IS required instead of falling
    // back to npm on the user machine.
    const shim = resolve(vendorRoot, 'bin', 'coworkd-node.js');
    if (!existsSync(shim)) {
      console.error(
        '[trylo-workd] real mode requires either the packaged sidecar '
        + `(dist/daemon/daemon/main.js under ${packagedCandidates.join(' or ')}) `
        + `or the dev vendor checkout (${shim}).`,
      );
      process.exit(1);
    }
    const child = spawn(process.execPath, [shim, ...process.argv.slice(2)], {
      cwd: vendorRoot,
      stdio: 'inherit',
      env: coworkEnv,
    });
    child.on('close', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error('[trylo-workd] failed to spawn coworker daemon:', err);
      process.exit(1);
    });
  }
} else {
  // ── Stub: same HTTP shape, no coworker deps ──────────────────────────
  // Kept verbatim from Phase 0. The Control Plane contract is intentionally
  // minimal so we can swap real ↔ stub without touching the renderer.
  const PORT = Number.parseInt(process.env.TRYLO_WORKD_PORT ?? '47821', 10);
  const HOST = process.env.TRYLO_WORKD_HOST ?? '127.0.0.1';
  const startedAt = Date.now();
  const VERSION = '0.0.0-phase1';

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          runtime: 'trylo-workd',
          version: VERSION,
          uptimeMs: Date.now() - startedAt,
          mode,
          // Real mode flips this once coworker boots. Stub mode
          // always reports "phase1-stub" so the renderer can tell
          // when it's not actually running the agent.
          backend: mode === 'real' ? 'cowork-os' : 'phase1-stub',
        }),
      );
      return;
    }
    if (url.pathname === '/v1/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echoed: body, at: Date.now() }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }));
  });

  server.listen(PORT, HOST, () => {
    console.log(`[trylo-workd] listening on http://${HOST}:${PORT} (mode=${mode}, stub)`);
  });

  const shutdown = (signal) => {
    console.log(`[trylo-workd] received ${signal}, closing`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
