// Trylo Desktop Services — Template Copy (PR-6).
//
// Spec TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §2.8 / §5 / §7.
//
// The apply-time privileged copy of a `.trylo/out` deliverable into the
// Hermes Skill tree at `{HERMES_HOME}/skills/<skillName>/templates/<slug>.<ext>`.
// The copyPlan (sourceRel, expectedBytes, expectedMtimeMs, skillName) is
// FIXED at review time; this service only READS it and never re-scans
// `.trylo/out` as the source of truth (spec §2.8).
//
// Failure policy — fail-closed per §5 rules 7-9:
//   - source not under `.trylo/out` (shape), symlink, >20 MiB, or bad
//     extension → NOT copied, Skill still applied, `template_copy_skipped`;
//   - source missing / mtime·size drift > 10% → `template_copy_missing_source`,
//     Skill text retained;
//   - no `skillName` in the copyPlan → NOT copied, Skill still applied
//     (never parsed from the opaque `applyPending.result`);
//   - destination escapes the Skill tree / is not under
//     `<HERMES_HOME>/skills/` → NOT copied, `template_copy_skipped`.
//   Every failure is `ok:true` + `copied:false` + a reasonCode (the Skill
//   apply already happened and must not be reported as a copy failure).
//
// Trust boundary: every path is validated lexically BEFORE any I/O (control
// chars, UNC/device paths, `..` segments, reserved device names). The source
// is opened with `lstat` and re-checked — a symlink is rejected even if the
// lexical shape passes.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024; // 20 MiB (spec §5 rule 7)
const SIZE_DRIFT_RATIO = 0.1; // ±10% (spec §5 rule 8)
const DELIVERABLE_EXT_RE = /\.(pptx|ppt|docx|xlsx|pdf|md|html|csv)$/i;

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Validate a POSIX-slash relative path that must live under `.trylo/out`. */
export function validateOutRelPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'malformed_path';
  if (hasControlChars(raw)) return 'invalid_path';
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('//./') || normalized.startsWith('//?/')) return 'device_path';
  if (normalized.startsWith('//')) return 'unc_path';
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) return 'absolute_path';
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.length === 0) return 'malformed_path';
  if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) return 'reserved_device_name';
  if (segments.some((s) => s === '..')) return 'dotdot_segment';
  if (segments[0] !== '.trylo' || segments[1] !== 'out') return 'not_under_out';
  if (segments.length < 3) return 'not_under_out';
  return null;
}

/** Validate the ABSOLUTE destination path shape: must be inside the Hermes
 *  skills tree. Returns a reason string, or null when safe. */
export function validateDestAbs(destAbs, hermesHome) {
  if (typeof destAbs !== 'string' || destAbs.trim() === '') return 'malformed_dest';
  if (hasControlChars(destAbs)) return 'invalid_dest';
  const normalized = destAbs.replace(/\\/g, '/');
  const homeNormalized = hermesHome.replace(/\\/g, '/').replace(/\/+$/, '');
  const expectedPrefix = `${homeNormalized}/skills/`;
  if (!normalized.startsWith(expectedPrefix)) return 'dest_outside_skills';
  const rel = normalized.slice(expectedPrefix.length);
  if (rel === '' || rel.startsWith('/')) return 'dest_outside_skills';
  if (rel.split('/').some((s) => s === '..' || s === '')) return 'dest_outside_skills';
  return null;
}

function isInsideRoot(full, root) {
  const lower = (p) => p.toLowerCase();
  const sep = path.sep === '\\' ? '\\' : '/';
  const same = lower(full) === lower(root);
  const nested = full.length > root.length && lower(full).startsWith(`${lower(root)}${sep}`);
  return same || nested;
}

function isDeliverableExt(rel) {
  return DELIVERABLE_EXT_RE.test(rel);
}

/**
 * Copy a `.trylo/out` deliverable into the Hermes Skill tree (PR-6).
 *
 * @param {{ workspaceRoot: string, sourceRel: string, destAbs: string,
 *            expectedBytes?: number, expectedMtimeMs?: number,
 *            hermesHome: string }} params
 *   `hermesHome` is the resolved `{HERMES_HOME}` (spec §7.2).
 * @returns {Promise<{ ok: true, copied: true, destAbs: string, bytes: number }>
 *             | { ok: true, copied: false, reasonCode: string }
 *             | { ok: false, error: string }>}
 */
export async function copyTemplateUnderOut(params) {
  const workspaceRoot = String(params?.workspaceRoot ?? '');
  const sourceRel = String(params?.sourceRel ?? '');
  const destAbs = String(params?.destAbs ?? '');
  const hermesHome = String(params?.hermesHome ?? '');
  if (!workspaceRoot || !sourceRel || !destAbs || !hermesHome) {
    return { ok: false, error: 'missing required params (workspaceRoot, sourceRel, destAbs, hermesHome)' };
  }

  // 1. Destination shape — must be inside <HERMES_HOME>/skills/.
  const destReason = validateDestAbs(destAbs, hermesHome);
  if (destReason) return { ok: true, copied: false, reasonCode: destReason };

  // 2. Source lexical shape — must live under `.trylo/out`.
  const srcReason = validateOutRelPath(sourceRel);
  if (srcReason) return { ok: true, copied: false, reasonCode: srcReason };

  // 3. Extension allowlist (spec §2.2 / §5 rule 7).
  if (!isDeliverableExt(sourceRel)) {
    return { ok: true, copied: false, reasonCode: 'bad_extension' };
  }

  const sourceAbs = path.resolve(workspaceRoot, ...sourceRel.replace(/\\/g, '/').split('/'));
  const outRoot = path.resolve(workspaceRoot, '.trylo', 'out');
  if (!isInsideRoot(sourceAbs, outRoot)) {
    return { ok: true, copied: false, reasonCode: 'path_outside_out' };
  }

  // 4. Symlink / regular-file guard — `lstat` never follows a link.
  let stat;
  try {
    stat = await fsp.lstat(sourceAbs);
  } catch {
    return { ok: true, copied: false, reasonCode: 'template_copy_missing_source' };
  }
  if (stat.isSymbolicLink()) {
    return { ok: true, copied: false, reasonCode: 'symlink_source' };
  }
  if (!stat.isFile()) {
    return { ok: true, copied: false, reasonCode: 'not_a_regular_file' };
  }

  // 5. Size guard (spec §5 rule 7).
  if (stat.size > MAX_TEMPLATE_BYTES) {
    return { ok: true, copied: false, reasonCode: 'too_large' };
  }
  if (stat.size <= 0) {
    return { ok: true, copied: false, reasonCode: 'empty_source' };
  }

  // 6. Drift guard (spec §5 rule 8): expectedBytes / expectedMtimeMs from the
  //    review-time copyPlan. ±10% on mtime (ms) or exact on size (bytes).
  if (typeof params.expectedBytes === 'number' && params.expectedBytes > 0) {
    const drift = Math.abs(stat.size - params.expectedBytes) / params.expectedBytes;
    if (drift > SIZE_DRIFT_RATIO) {
      return { ok: true, copied: false, reasonCode: 'size_drift' };
    }
  }
  if (typeof params.expectedMtimeMs === 'number' && params.expectedMtimeMs > 0) {
    const mtimeDrift = Math.abs(stat.mtimeMs - params.expectedMtimeMs) / Math.max(1, params.expectedMtimeMs);
    if (mtimeDrift > SIZE_DRIFT_RATIO) {
      return { ok: true, copied: false, reasonCode: 'mtime_drift' };
    }
  }

  // 7. Copy (never move; never overwrite — refuse an existing dest).
  try {
    await fsp.mkdir(path.dirname(destAbs), { recursive: true });
    if (fs.existsSync(destAbs)) {
      return { ok: true, copied: false, reasonCode: 'dest_exists' };
    }
    await fsp.copyFile(sourceAbs, destAbs);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }

  const copiedStat = await fsp.stat(destAbs).catch(() => null);
  return { ok: true, copied: true, destAbs, bytes: copiedStat?.size ?? stat.size };
}

export default { copyTemplateUnderOut, validateOutRelPath, validateDestAbs };