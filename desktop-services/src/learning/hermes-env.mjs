// Trylo Desktop Services — Hermes path/env resolution. See migration spec
// §7.2 (storage root) and vendor/PATCHES.md (why the env vars exist).
//
// This is the ONLY place that derives Hermes paths from the Service Host env
// contract (TRYLO_APP_DATA_DIR / TRYLO_SIDECARS_DIR, spec §5.5). Everything
// else takes these values as arguments.
//
// Ownership: the Tauri shell owns the real directories; this module only
// projects them. It must run BEFORE any vendored legacy module is required,
// because those modules resolve their Python script paths at load time
// (vendor/PATCHES.md patches 1–6).
//
// Failure policy: never throws. A missing/unresolvable directory yields empty
// strings and the callers degrade (Hermes is non-essential for Code/Work).

import path from 'node:path';

/** Storage namespace under the Tauri app_data_dir (spec §7.2 / arch §6.2):
 *  <app-data>/Trylo/hermes-capabilities/v1 is HERMES_HOME. */
export const STORAGE_SUBDIR = 'Trylo';

/** The Python capabilities directory inside the packaged sidecars root. */
const CAPABILITIES_SUBDIR = 'hermes-capabilities';

export function storageRoot(appDataDir = process.env.TRYLO_APP_DATA_DIR || '') {
  if (!appDataDir) return '';
  return path.join(appDataDir, STORAGE_SUBDIR);
}

export function capabilitiesDir(sidecarsDir = process.env.TRYLO_SIDECARS_DIR || '') {
  if (!sidecarsDir) return '';
  return path.join(sidecarsDir, CAPABILITIES_SUBDIR);
}

export function serverScriptPath(capabilities) {
  return capabilities ? path.join(capabilities, 'server.py') : '';
}

/**
 * Publish the Hermes paths into `process.env` for the vendored legacy modules
 * and return the resolved layout. Idempotent.
 *
 * @param {{ appDataDir?: string, sidecarsDir?: string }} [overrides]
 *   Test seam: defaults to the Service Host env.
 * @returns {{ storageRoot: string, capabilitiesDir: string, serverScript: string,
 *             configured: boolean }}
 *   `configured:false` means the shell gave us no directories — Hermes calls
 *   will degrade (spec §7.3: silent degrade for the main run, fail-closed for
 *   learning/history runners).
 */
export function configureHermesEnv(overrides = {}) {
  const appDataDir = overrides.appDataDir ?? process.env.TRYLO_APP_DATA_DIR ?? '';
  const sidecarsDir = overrides.sidecarsDir ?? process.env.TRYLO_SIDECARS_DIR ?? '';
  const root = storageRoot(appDataDir);
  const capabilities = capabilitiesDir(sidecarsDir);
  const serverScript = serverScriptPath(capabilities);

  if (capabilities) {
    process.env.TRYLO_HERMES_CAPABILITIES_DIR = capabilities;
  }
  if (serverScript) {
    process.env.TRYLO_HERMES_SERVER_SCRIPT = serverScript;
  }
  return {
    storageRoot: root,
    capabilitiesDir: capabilities,
    serverScript,
    configured: Boolean(root && capabilities),
  };
}
