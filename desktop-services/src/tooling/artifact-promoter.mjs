// Trylo Desktop Services — Artifact Promoter.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 / §7.3 / §8.2.
//
// The browser (and later other packages) may write process artifacts —
// downloads, screenshots, page dumps — ONLY into the per-conversation
// runtime dir: `<projectRoot>/.trylo/runtime/<dirName>/<conversationId>`.
// That area is a controlled TEMP zone; it is never a deliverable (§7.3).
// The promoter is the explicit, audited step that copies one artifact from
// the temp zone into `<projectRoot>/.trylo/out/` — the ONLY place the
// ResultDock's deliverable scanner looks.
//
// Trust boundary: every path is validated lexically BEFORE any I/O (same
// rule family as the risk classifier: control chars, UNC/device paths,
// drive-relative forms, reserved device names, `..` segments). Symlink and
// reparse escapes are re-checked by the Rust host's canonicalize at scan
// time; this module never follows a link out of the runtime dir.
//
// Failure policy: never throws — every failure is an `ok:false` reason
// code the caller can show verbatim.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Bounded scan: no deeper than 2 levels, no more than 100 entries. */
const MAX_LIST_ENTRIES = 100;
const MAX_LIST_DEPTH = 2;

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate one artifact-relative path (forward or back slashes accepted;
 * MUST be relative). Returns null when the path is safe, else a reason.
 * @param {string} raw
 */
export function validateArtifactRelativePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'malformed_path';
  if (hasControlChars(raw)) return 'invalid_path';
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('//./') || normalized.startsWith('//?/')) return 'device_path';
  if (normalized.startsWith('//')) return 'unc_path';
  if (/^[a-zA-Z]:(?![/\\]|$)/.test(raw)) return 'drive_relative_path';
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) return 'absolute_path';
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.length === 0) return 'malformed_path';
  if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) return 'reserved_device_name';
  if (segments.some((s) => s === '..')) return 'dotdot_segment';
  return null;
}

function isInsideRoot(full, root) {
  const lower = (p) => p.toLowerCase();
  const sep = path.sep === '\\' ? '\\' : '/';
  const same = lower(full) === lower(root);
  const nested = full.length > root.length && lower(full).startsWith(`${lower(root)}${sep}`);
  return same || nested;
}

export function createArtifactPromoter(options = {}) {
  const now = options.now ?? (() => Date.now());

  function runtimeRootFor(projectRoot, packageId, conversationId, dirName) {
    return path.join(
      path.resolve(projectRoot),
      '.trylo',
      'runtime',
      dirName ?? packageId,
      conversationId,
    );
  }

  function outRootFor(projectRoot) {
    return path.join(path.resolve(projectRoot), '.trylo', 'out');
  }

  /**
   * List the process artifacts currently sitting in one conversation's
   * runtime temp dir. Bounded; oldest-last ordering is not guaranteed.
   */
  async function list(params = {}) {
    const projectRoot = String(params.projectRoot ?? '');
    const conversationId = String(params.conversationId ?? '');
    const packageId = String(params.packageId ?? '');
    const dirName = params.dirName ? String(params.dirName) : null;
    if (!projectRoot || !conversationId || !packageId) {
      return { ok: false, reasonCode: 'missing_scope', artifacts: [] };
    }
    const root = runtimeRootFor(projectRoot, packageId, conversationId, dirName);
    const artifacts = [];
    try {
      await walk(root, root, artifacts, 0);
    } catch {
      // A missing/unreadable runtime dir is the normal empty case.
    }
    return { ok: true, root, artifacts };
  }

  async function walk(root, dir, out, depth) {
    if (out.length >= MAX_LIST_ENTRIES || depth > MAX_LIST_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(root, full, out, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = await fsp.stat(full);
        size = stat.size;
        modifiedAt = stat.mtimeMs;
      } catch {
        continue;
      }
      out.push({
        name: path.relative(root, full).replace(/\\/g, '/'),
        size,
        modifiedAt: Math.round(modifiedAt),
      });
    }
  }

  /**
   * Promote ONE artifact from the conversation's runtime temp dir into
   * `<projectRoot>/.trylo/out/`. The source file is COPIED, never moved —
   * the temp copy remains for the run to keep using, and a failed promote
   * leaves both sides untouched.
   *
   * @param {{ projectRoot: string, conversationId: string, packageId: string,
   *            fileName: string, dirName?: string, targetName?: string }} params
   */
  async function promote(params = {}) {
    const projectRoot = String(params.projectRoot ?? '');
    const conversationId = String(params.conversationId ?? '');
    const packageId = String(params.packageId ?? '');
    const dirName = params.dirName ? String(params.dirName) : null;
    const fileName = params.fileName != null ? String(params.fileName) : '';
    const badScope = !projectRoot || !conversationId || !packageId;
    if (badScope) return { ok: false, reasonCode: 'missing_scope' };
    const invalid = validateArtifactRelativePath(fileName);
    if (invalid) return { ok: false, reasonCode: invalid };
    if (params.targetName !== undefined) {
      const invalidTarget = validateArtifactRelativePath(String(params.targetName));
      if (invalidTarget) return { ok: false, reasonCode: invalidTarget };
    }

    const runtimeRoot = runtimeRootFor(projectRoot, packageId, conversationId, dirName);
    const source = path.resolve(runtimeRoot, ...fileName.replace(/\\/g, '/').split('/'));
    // Lexical containment: the resolved source must still sit inside the
    // runtime root (belt over braces — the segments cannot escape after
    // the `..` ban, but resolve() also collapses `.` runs).
    if (!isInsideRoot(source, runtimeRoot)) return { ok: false, reasonCode: 'path_outside_runtime' };
    let stat;
    try {
      stat = await fsp.lstat(source);
    } catch {
      return { ok: false, reasonCode: 'artifact_missing' };
    }
    if (!stat.isFile()) return { ok: false, reasonCode: 'not_a_regular_file' };
    if (stat.size <= 0) return { ok: false, reasonCode: 'artifact_empty' };

    const outRoot = outRootFor(projectRoot);
    const base = params.targetName !== undefined ? String(params.targetName) : path.basename(source);
    let target = path.join(outRoot, base);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 1; fs.existsSync(target); i += 1) {
      target = path.join(outRoot, `${stem}-${i}${ext}`);
    }

    try {
      await fsp.mkdir(outRoot, { recursive: true });
      await fsp.copyFile(source, target);
    } catch (error) {
      return { ok: false, reasonCode: 'promote_failed', error: String(error?.message ?? error).slice(0, 200) };
    }

    let digest = null;
    try {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(target);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      digest = hash.digest('hex');
    } catch {
      digest = null;
    }

    const promotedStat = await fsp.stat(target).catch(() => null);
    return {
      ok: true,
      source,
      target,
      size: promotedStat?.size ?? stat.size,
      sha256: digest,
      promotedAt: now(),
    };
  }

  return { list, promote, runtimeRootFor, outRootFor };
}

export default createArtifactPromoter;
