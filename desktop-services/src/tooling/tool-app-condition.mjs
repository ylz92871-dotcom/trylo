// Trylo Desktop Services — host-application install condition probe.
//
// Extends the §3.3-7 condition pattern (tool-browser-condition.mjs) from
// "the browser body" to "the HOST APPLICATION a package automates". A CAD/EDA
// MCP package whose digest is perfect is still unusable when the application
// it drives is not installed (or its automation bridge is not running) — the
// health record must say so honestly instead of showing 完全可用.
//
// Three condition kinds, declared by a manifest's `installCondition`:
//
//   executable-glob  filesystem markers under well-known roots. Pure fs,
//                    side-effect free, never spawns anything. (KiCad, FreeCAD,
//                    Blender install bodies.)
//   com-progid       COM automation presence WITHOUT launching the app: a
//                    read-only `reg query HKCR\<ProgID>` (exit code only),
//                    with an optional filesystem-marker fallback for portable
//                    installs. Spawning `reg.exe` reads the registry; it never
//                    constructs the COM object, so no CAD process starts.
//                    (SolidWorks `SldWorks.Application`, AutoCAD
//                    `AutoCAD.Application`.)
//   app-bridge       two layers: fs install markers (is the app installed?)
//                    PLUS a live loopback bridge port (is the app running
//                    with its automation bridge enabled?). (嘉立创EDA专业版
//                    official Bridge Server, the Blender/FreeCAD addon
//                    socket servers.)
//
// Failure policy: never throws. Any error degrades to a two-state record
// with a reason — the same §4.4 contract as every other health check.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runBounded } from './office-validator.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Windows directory wildcards are illegal in filenames; they never match. */
const SEGMENT_NO_WILDCARD = '[^\\\\/:*?"<>|]*';

/** Expand `${ENV_VAR}` placeholders in a root template. A root whose
 *  environment variable is missing is dropped (it cannot exist here). */
export function expandRoots(rootTemplates, env = process.env) {
  const roots = [];
  for (const template of rootTemplates ?? []) {
    const expanded = template.replace(/\$\{([^}]+)\}/g, (_, name) => {
      const value = env[name];
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : '\u0000-missing-env-';
    });
    if (expanded.includes('\u0000-missing-env-')) continue;
    roots.push(expanded);
  }
  return roots;
}

/** One marker segment → case-insensitive matcher. `*` stays within the
 *  segment (it never crosses a separator). */
function segmentRegExp(segment) {
  const parts = segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join(SEGMENT_NO_WILDCARD)}$`, 'i');
}

function splitPattern(marker) {
  return marker.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
}

/** Depth-first match of one marker pattern under a root. Newest-looking
 *  candidates first (numeric-aware desc) so the reported path is stable. */
function matchMarker(rootDir, segments) {
  if (segments.length === 0) return null;

  function walk(dir, rest) {
    if (rest.length === 0) {
      try {
        return fs.statSync(dir).isFile() ? dir : null;
      } catch {
        return null;
      }
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const re = segmentRegExp(rest[0]);
    const names = entries
      .filter((entry) => re.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    for (const name of names) {
      const hit = walk(path.join(dir, name), rest.slice(1));
      if (hit) return hit;
    }
    return null;
  }

  return walk(rootDir, segments);
}

/**
 * `executable-glob`: the application exists when any root × marker pair has
 * an executable file on disk.
 *
 * @returns {{ ok: boolean, reasonCode: 'app_ok'|'app_not_installed',
 *             detail: string, found: string|null }}
 */
export function probeExecutableGlob(condition, options = {}) {
  const env = options.env ?? process.env;
  const roots = expandRoots(condition.roots ?? [], env);
  const markers = condition.markers ?? [];
  const label = condition.label ?? 'application';

  let anyRootExists = false;
  for (const root of roots) {
    let stat = null;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    anyRootExists = true;
    for (const marker of markers) {
      const hit = matchMarker(root, splitPattern(marker));
      if (hit) {
        return { ok: true, reasonCode: 'app_ok', detail: `${label} found: ${hit}`, found: hit };
      }
    }
  }
  return {
    ok: false,
    reasonCode: 'app_not_installed',
    detail: anyRootExists
      ? `${label} not found: no install marker matched under the well-known roots`
      : `${label} not found: none of the well-known install roots exist`,
    found: null,
  };
}

/**
 * Read-only registry existence check for one `HKCR\<key>`. Resolves false on
 * any failure (missing reg.exe, timeout, denied) — a probe that cannot read
 * must read as "not proven", never as a crash. Never launches the app.
 */
export function defaultRegQuery(key, timeoutMs = 1500) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? '';
  const reg = systemRoot ? path.join(systemRoot, 'System32', 'reg.exe') : 'reg';
  return runBounded(reg, ['query', key, '/ve'], timeoutMs).then((outcome) => outcome.code === 0);
}

/**
 * `com-progid`: COM automation is present when the ProgID is registered
 * (cheap registry read — NEVER `new ActiveXObject`, which would start the
 * CAD process) or, as a fallback for portable installs that registered
 * manually, when a filesystem marker matches.
 */
export async function probeComProgId(condition, options = {}) {
  const regQuery = options.regQuery ?? defaultRegQuery;
  const label = condition.label ?? condition.progid ?? 'application';

  if (isNonEmptyString(condition.progid)) {
    let registered = false;
    try {
      registered = await regQuery(`HKCR\\${condition.progid}`);
    } catch {
      registered = false;
    }
    if (registered) {
      return {
        ok: true,
        reasonCode: 'app_ok',
        detail: `COM ProgID registered: ${condition.progid}`,
        found: condition.progid,
      };
    }
  }

  if ((condition.roots?.length ?? 0) > 0 && (condition.markers?.length ?? 0) > 0) {
    const fallback = probeExecutableGlob(condition, options);
    if (fallback.ok) return fallback;
    return {
      ok: false,
      reasonCode: 'app_not_installed',
      detail: `${label}: COM ProgID '${condition.progid}' not registered and no install marker matched`,
      found: null,
    };
  }

  return {
    ok: false,
    reasonCode: 'app_not_installed',
    detail: `${label}: COM ProgID '${condition.progid}' is not registered`,
    found: null,
  };
}

function expandPortRange(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
  if (from < 1 || to > 65535 || from > to) return [];
  // Bridge ranges are small by nature; a huge range is a manifest defect the
  // validator owns. Runtime still refuses to sweep hundreds of ports.
  if (to - from > 64) return [];
  const ports = [];
  for (let port = from; port <= to; port += 1) ports.push(port);
  return ports;
}

/** TCP connect probe. Resolves true only when the connection is ESTABLISHED
 *  within the bound; the socket is destroyed either way. */
export function defaultTcpProbe(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    // eslint-disable-next-line no-empty-function
    const timer = setTimeout(() => finish(false), timeoutMs);
    let socket;
    try {
      socket = net.connect({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * `app-bridge`: the automation bridge is reachable only when BOTH layers
 * hold — the application is installed (fs markers) AND its local bridge
 * port answers (the app is running with the bridge enabled).
 *
 * The two failure modes get different reasonCodes so the Settings copy can
 * tell the user exactly what to do next (install vs. launch + enable).
 */
export async function probeAppBridge(condition, options = {}) {
  const label = condition.label ?? 'application';
  const bridge = condition.bridge ?? {};
  const host = isNonEmptyString(bridge.host) ? bridge.host : '127.0.0.1';
  const ports = expandPortRange(bridge.from, bridge.to);
  const tcpProbe = options.tcpProbe ?? defaultTcpProbe;

  const fsResult = probeExecutableGlob({ ...condition, label }, options);
  if (!fsResult.ok) {
    // Some editors (嘉立创EDA专业版) install under paths that are not stable
    // enough to marker-probe. `allowBridgeOnly` downgrades the fs layer to
    // advisory: a live bridge port alone still proves the automation surface
    // is up, which is the only thing the MCP server actually needs.
    if (condition.allowBridgeOnly && ports.length > 0) {
      for (const port of ports) {
        let open = false;
        try {
          open = await tcpProbe(host, port);
        } catch {
          open = false;
        }
        if (open) {
          return {
            ok: true,
            reasonCode: 'app_ok',
            detail: `${label} bridge reachable at ${host}:${port} (install marker not matched; bridge is authoritative)`,
            found: `${host}:${port}`,
          };
        }
      }
    }
    return {
      ok: false,
      reasonCode: 'app_not_installed',
      detail: `${label} is not installed (${fsResult.detail})`,
      found: null,
    };
  }

  if (ports.length === 0) {
    return {
      ok: false,
      reasonCode: 'bridge_not_running',
      detail: `${label} is installed (${fsResult.found}) but the manifest declares no usable bridge port range`,
      found: fsResult.found,
    };
  }

  const first = ports[0];
  const last = ports[ports.length - 1];
  for (const port of ports) {
    let open = false;
    try {
      open = await tcpProbe(host, port);
    } catch {
      open = false;
    }
    if (open) {
      return {
        ok: true,
        reasonCode: 'app_ok',
        detail: `${label} installed and bridge reachable at ${host}:${port}`,
        found: `${host}:${port}`,
      };
    }
  }
  return {
    ok: false,
    reasonCode: 'bridge_not_running',
    detail: `${label} is installed (${fsResult.found}) but its automation bridge is not reachable on ${host}:${first}-${last}`,
    found: fsResult.found,
  };
}

/**
 * Dispatch on `condition.kind`. Unknown/invalid conditions fail CLOSED:
 * a malformed manifest field must degrade the capability, never pass it.
 */
export async function probeAppCondition(condition, options = {}) {
  if (!condition || typeof condition !== 'object') {
    return { ok: false, reasonCode: 'condition_invalid', detail: 'installCondition is missing', found: null };
  }
  switch (condition.kind) {
    case 'executable-glob':
      return probeExecutableGlob(condition, options);
    case 'com-progid':
      return probeComProgId(condition, options);
    case 'app-bridge':
      return probeAppBridge(condition, options);
    default:
      return {
        ok: false,
        reasonCode: 'condition_unsupported',
        detail: `unknown installCondition.kind '${String(condition.kind)}'`,
        found: null,
      };
  }
}

export default probeAppCondition;
