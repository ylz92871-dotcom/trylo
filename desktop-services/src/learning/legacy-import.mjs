// Trylo Desktop Services — legacy Hermes data importer (Phase 3B follow-up).
// See migration spec §7.5 and architecture doc §6.2.
//
// Moves the OLD VS Code plugin's Hermes data into the Trylo Desktop storage
// root. It is a copy, never a move: the old location is left untouched so the
// import can be re-run and the old plugin keeps working (spec §7.5: 不删除老数据，
// 可重跑).
//
// Ownership: Hermes owns everything under `hermes-capabilities/v1`. This
// module only relocates it — it never parses, rewrites or "repairs" Hermes
// files, and it never deletes anything.
//
// Failure policy: `plan` is read-only and never throws. `commit` copies
// non-destructively (an existing target file is SKIPPED, never overwritten)
// and writes a marker so a second run is a no-op. Any failure is returned as
// `{ ok:false, error }` — a failed import must not block the app.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** `getDataRoot()` in the legacy plugin (vendor/legacy/hermes-capability-manager.js). */
const DATA_DIR_NAME = 'hermes-capabilities';
/** `DATA_VERSION` — the Hermes home inside the data root. */
const DATA_VERSION = 'v1';
const MARKER_NAME = 'trylo-import-marker.json';

/** VS Code extension id from the legacy package.json (publisher.name). */
const LEGACY_EXTENSION_ID = 'local.trylo-code';

/**
 * Candidate legacy storage roots, most likely first. Windows-only today: the
 * old plugin was Windows-only, so POSIX roots would only produce false
 * positives. Callers may pass explicit `candidates` (user picked a folder).
 */
export function defaultLegacyCandidates(env = process.env) {
  const appData = env.APPDATA || '';
  if (!appData) return [];
  const userDataRoots = [
    path.join(appData, 'Code', 'User', 'globalStorage'),
    path.join(appData, 'Code - Insiders', 'User', 'globalStorage'),
  ];
  return userDataRoots.map((root) => path.join(root, LEGACY_EXTENSION_ID));
}

async function isDirectory(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function countFiles(root) {
  let files = 0;
  let bytes = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          const stat = await fs.stat(full);
          bytes += stat.size;
        } catch {
          /* a file that vanishes mid-walk is not an error worth failing on */
        }
      }
    }
  }
  if (await isDirectory(root)) await walk(root);
  return { files, bytes };
}

/**
 * @param {{ storageRoot: string, log?: (m: string) => void }} options
 */
export function createLegacyImportService({ storageRoot, log = null } = {}) {
  function targetRoot() {
    return storageRoot ? path.join(storageRoot, DATA_DIR_NAME) : '';
  }
  function targetHome() {
    const root = targetRoot();
    return root ? path.join(root, DATA_VERSION) : '';
  }
  function markerPath() {
    const root = targetRoot();
    return root ? path.join(root, MARKER_NAME) : '';
  }

  async function readMarker() {
    const marker = markerPath();
    if (!marker) return null;
    try {
      return JSON.parse(await fs.readFile(marker, 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    /**
     * Read-only discovery. Reports every legacy Hermes home it can find plus
     * whether the Desktop target already has data (spec §7.5: verify before
     * overwriting anything).
     */
    async plan(params = {}) {
      if (!storageRoot) {
        return { ok: false, error: 'hermes storage root is not configured', candidates: [] };
      }
      const candidates = Array.isArray(params.candidates) && params.candidates.length > 0
        ? params.candidates
        : defaultLegacyCandidates();

      const found = [];
      for (const candidate of candidates) {
        const home = path.join(candidate, DATA_DIR_NAME, DATA_VERSION);
        if (!(await isDirectory(home))) continue;
        const stats = await countFiles(home);
        found.push({
          source: candidate,
          hermesHome: home,
          files: stats.files,
          bytes: stats.bytes,
        });
      }

      const targetStats = await countFiles(targetHome());
      const marker = await readMarker();
      return {
        ok: true,
        candidates: found,
        target: {
          hermesHome: targetHome(),
          files: targetStats.files,
          bytes: targetStats.bytes,
        },
        alreadyImported: marker ?? null,
      };
    },

    /**
     * Non-destructive copy of one legacy home into the Desktop storage root,
     * then mark it imported. Existing files are SKIPPED, never overwritten.
     */
    async commit(params = {}) {
      if (!storageRoot) return { ok: false, error: 'hermes storage root is not configured' };
      const source = String(params.source ?? '');
      if (!source) return { ok: false, error: 'commit requires a legacy source path from plan()' };

      const sourceHome = path.join(source, DATA_DIR_NAME, DATA_VERSION);
      if (!(await isDirectory(sourceHome))) {
        return { ok: false, error: `legacy Hermes home not found: ${sourceHome}` };
      }

      const destination = targetHome();
      const marker = await readMarker();
      if (marker && marker.source === source) {
        return { ok: true, skipped: true, copied: 0, skippedFiles: 0, marker };
      }

      let copied = 0;
      let skippedFiles = 0;
      try {
        await fs.mkdir(destination, { recursive: true });
        await copyTree(sourceHome, destination);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (log) log(`legacy import failed: ${message}`);
        return { ok: false, error: message };
      }

      async function copyTree(from, to) {
        const entries = await fs.readdir(from, { withFileTypes: true });
        for (const entry of entries) {
          const sourcePath = path.join(from, entry.name);
          const targetPath = path.join(to, entry.name);
          if (entry.isDirectory()) {
            await fs.mkdir(targetPath, { recursive: true });
            await copyTree(sourcePath, targetPath);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            // Never overwrite: the newest Desktop-side state wins.
            await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
            copied += 1;
          } catch (err) {
            if (err && err.code === 'EEXIST') {
              skippedFiles += 1;
              continue;
            }
            throw err;
          }
        }
      }

      const record = {
        importedAt: new Date().toISOString(),
        source,
        sourceHome,
        host: os.hostname(),
        copied,
        skippedFiles,
      };
      try {
        await fs.writeFile(markerPath(), JSON.stringify(record, null, 2), 'utf8');
      } catch (err) {
        if (log) log(`legacy import: marker write failed: ${err && err.message ? err.message : err}`);
      }

      // Verify: the target must now contain at least everything the source had.
      const targetStats = await countFiles(destination);
      const sourceStats = await countFiles(sourceHome);
      return {
        ok: true,
        skipped: false,
        copied,
        skippedFiles,
        verified: targetStats.files >= sourceStats.files,
        sourceFiles: sourceStats.files,
        targetFiles: targetStats.files,
        marker: record,
      };
    },
  };
}
