// Trylo Desktop Services — remote identity store (migration spec §8.1.3, arch §7.4).
//
// Single writer of <app-data>/Trylo/remote/identity.json. The schema is
// ISOMORPHIC to the legacy plugin's remote-identity.json
// (`{ version, pairingToken, deviceSeed, updatedAt }` — extension.js ~7236),
// so an imported identity needs no reshape and a later export stays
// compatible.
//
// Ownership/failure policy:
//   - the token is a 32-byte base64url string (legacy contract, `authToken`
//     must be >= 32 chars per remote-gateway/index.js);
//   - the token NEVER goes to stdout/stderr and never into Desktop settings
//     (spec §8.1.3 / arch §7.4 — it leaves this process only inside the
//     pairing payload / gateway auth header);
//   - writes are atomic (temp file + rename) and only happen when the file
//     is missing — an existing identity is never overwritten by
//     loadOrCreate, so a restart cannot rotate a token out from under an
//     already-paired phone;
//   - importLegacy() copies a legacy remote-identity.json once, only when no
//     identity.json exists yet, so a later pairing survives.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REMOTE_IDENTITY_FILE = 'remote-identity.json';
const IDENTITY_FILE = 'identity.json';
const IDENTITY_VERSION = 1;

/** `<appDataDir>/Trylo/remote/identity.json`; '' when no root. */
export function remoteIdentityFilePath(appDataDir) {
  const root = String(appDataDir || '').trim();
  if (!root) return '';
  return path.join(root, 'Trylo', 'remote', IDENTITY_FILE);
}

/** 32 random bytes → base64url, the legacy token format. */
export function generatePairingToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Read-only parse of an identity file; null when absent/corrupt. */
export async function readIdentityFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pairingToken = typeof parsed.pairingToken === 'string' ? parsed.pairingToken : '';
    if (pairingToken.length < 32) return null;
    return {
      version: Number(parsed.version) || IDENTITY_VERSION,
      pairingToken,
      deviceSeed: typeof parsed.deviceSeed === 'string' ? parsed.deviceSeed : os.hostname(),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null; // corrupt file: treat as absent, never guess a token
  }
}

async function writeIdentity(filePath, identity) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(identity, null, 2), 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Windows: rename over an existing file can transiently fail; retry once.
    await fs.rm(filePath, { force: true });
    await fs.rename(tmp, filePath);
  }
}

/**
 * @param {{ appDataDir?: string, log?: (m: string) => void,
 *           now?: () => number, generateToken?: (() => string) }} [options]
 *   Defaults to the Service Host env (`TRYLO_APP_DATA_DIR`).
 */
export function createIdentityStore(options = {}) {
  const appDataDir = options.appDataDir ?? process.env.TRYLO_APP_DATA_DIR ?? '';
  const log = options.log ?? null;
  const now = options.now ?? (() => Date.now());
  const filePath = remoteIdentityFilePath(appDataDir);
  const generateToken = options.generateToken ?? generatePairingToken;

  /** Load existing or create+persist. Never rotates an existing token. */
  async function loadOrCreate() {
    if (!filePath) throw new Error('remote identity: app data dir is not configured');
    const existing = await readIdentityFile(filePath);
    if (existing) return existing;
    const identity = {
      version: IDENTITY_VERSION,
      pairingToken: generateToken(),
      deviceSeed: os.hostname(),
      updatedAt: now(),
    };
    await writeIdentity(filePath, identity);
    return identity;
  }

  /** Best-effort legacy import (arch §7.4): copy the old plugin's
   *  remote-identity.json verbatim into the Desktop identity slot. Runs
   *  ONCE — an existing Desktop identity is never replaced. */
  async function importLegacy({ legacyDir }) {
    const legacyPath = legacyDir
      ? path.join(String(legacyDir), REMOTE_IDENTITY_FILE)
      : '';
    if (!legacyPath) return { imported: false, skipped: true, reason: 'no legacy dir' };
    const existing = await readIdentityFile(filePath);
    if (existing) return { imported: false, skipped: true, reason: 'identity already exists' };
    const legacy = await readIdentityFile(legacyPath);
    if (!legacy) return { imported: false, skipped: true, reason: 'no legacy identity found' };
    await writeIdentity(filePath, {
      version: IDENTITY_VERSION,
      pairingToken: legacy.pairingToken,
      deviceSeed: legacy.deviceSeed || os.hostname(),
      updatedAt: now(),
    });
    if (log) log('remote identity: imported legacy pairing identity');
    return { imported: true, skipped: false };
  }

  return {
    /** Diagnostics only — the file path, never the token. */
    filePath,
    loadOrCreate,
    importLegacy,
  };
}
