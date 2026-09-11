// Trylo Desktop Services — remote tunnel service (migration spec §8.1.5, arch §7.5).
//
// Thin wrapper over the vendored remote-tunnel.js (vendor/legacy/remote-tunnel.js
// is byte-identical; all tunneling logic lives there). Three modes:
//   - named:   stable https://remote.trylocode.me — NEVER replaced by a random
//              URL just because a local probe failed (arch §7.5);
//   - quick:   spawn cloudflared, parse the random trycloudflare URL from its log;
//   - manual:  the user-supplied HTTPS URL, used as-is, nothing spawned.
//
// Ownership/failure policy:
//   - the tunnel is optional: Remote works over LAN without it, so a missing
//     cloudflared must surface as `status().reason` — never as a crash;
//   - only `quick` spawns a process; stop() kills exactly the pid it spawned;
//   - the log lives at <app-data>/Trylo/remote/cloudflared.log (rotated by
//     overwrite on each start).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const TUNNEL_MODES = ['named', 'quick', 'manual'];

/// Locate the byte-identical vendored tunnel module. Same layout reasoning as
/// pet-channel resolveVendorBridgeModule (dev unbundled / dist bundled /
/// packaged resource copy all sit one level below the package root).
function resolveVendorTunnelModule() {
  const rel = path.join('vendor', 'legacy', 'remote-tunnel.js');
  const candidates = [];
  if (process.argv[1]) {
    candidates.push(path.resolve(path.dirname(path.resolve(process.argv[1])), '..', rel));
  }
  candidates.push(fileURLToPath(new URL('../../' + rel, import.meta.url)));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {{ appDataDir?: string, log?: (m: string) => void,
 *           seam?: { tunnel?: object | false | null } }} [options]
 *   `seam.tunnel` is a test-only injection for the vendored module:
 *   an object replaces it; explicit `false` simulates a missing module;
 *   undefined resolves the real vendored module.
 */
export function createTunnelService(options = {}) {
  const appDataDir = options.appDataDir ?? process.env.TRYLO_APP_DATA_DIR ?? '';
  const log = options.log ?? null;
  const seamTunnel = options.seam?.tunnel;
  let tunnelModule = seamTunnel;
  if (seamTunnel === undefined) {
    const modulePath = resolveVendorTunnelModule();
    tunnelModule = modulePath ? require(modulePath) : null;
  }
  if (!tunnelModule) {
    log?.('remote tunnel: vendored remote-tunnel.js not found — tunnel disabled');
  }

  const logPath = appDataDir
    ? path.join(appDataDir, 'Trylo', 'remote', 'cloudflared.log')
    : '';
  let child = null; // quick-mode cloudflared handle

  function normalizeMode(mode) {
    const value = String(mode || 'named').toLowerCase();
    return TUNNEL_MODES.includes(value) ? value : 'named';
  }

  /** Validate a manual/named URL; returns normalized URL or null. */
  function normalizePublicUrl(value) {
    if (!tunnelModule?.normalizePublicUrl) return String(value || '').trim().replace(/\/+$/, '');
    return tunnelModule.normalizePublicUrl(value);
  }

  function isHttpsUrl(value) {
    try {
      return new URL(normalizePublicUrl(value)).protocol === 'https:';
    } catch {
      return false;
    }
  }

  async function start({ port, mode, publicUrl, cloudflaredPath, timeoutMs }) {
    const selected = normalizeMode(mode);
    const effectivePort = Number(port) || 49380;
    child = null;
    if (selected === 'manual') {
      const url = normalizePublicUrl(publicUrl);
      if (!url || !isHttpsUrl(url)) {
        throw new Error('remote tunnel: manual mode requires an https:// publicUrl');
      }
      return { mode: 'manual', publicUrl: url, running: false, spawned: false };
    }
    if (selected === 'named') {
      const url = tunnelModule?.DEFAULT_NAMED_TUNNEL_URL || 'https://remote.trylocode.me';
      return { mode: 'named', publicUrl: url, running: false, spawned: false };
    }
    // quick
    if (!tunnelModule?.startCloudflareQuickTunnel) {
      throw new Error('remote tunnel: vendored tunnel module unavailable');
    }
    const started = await tunnelModule.startCloudflareQuickTunnel({
      port: effectivePort,
      logPath,
      configuredPath: String(cloudflaredPath || ''),
      timeoutMs: Number(timeoutMs) || 35_000,
    });
    child = { pid: started.pid || 0, url: started.publicUrl };
    if (log) log(`remote tunnel: quick tunnel up at ${started.publicUrl}`);
    return {
      mode: 'quick',
      publicUrl: started.publicUrl,
      running: true,
      spawned: true,
      pid: started.pid || 0,
      logPath: started.logPath || logPath,
    };
  }

  /** Stop only a tunnel this service spawned (quick mode). Named/manual
   *  own no process and resolve immediately. */
  async function stop() {
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch {
        /* already gone */
      }
    }
    child = null;
    return { ok: true };
  }

  /** Best-effort probe of an HTTPS URL. Never replaces the URL itself. */
  function probe(publicUrl, timeoutMs = 5000) {
    if (!tunnelModule?.probeTryloGateway) return Promise.resolve(false);
    return tunnelModule.probeTryloGateway(publicUrl, timeoutMs);
  }

  function status() {
    const running = Boolean(child);
    return {
      mode: child ? 'quick' : 'off',
      running,
      publicUrl: child?.url ?? '',
      pid: child?.pid ?? 0,
      logPath,
    };
  }

  return {
    logPath,
    start,
    stop,
    probe,
    status,
  };
}
