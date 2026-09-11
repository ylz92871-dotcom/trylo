// Trylo Desktop — Work file hints (evidence capsule pointers).
// TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §2.2 / §2.6 / §7.
//
// The `.trylo/out` relative paths attached to an office review as `fileHints`.
// NO file bytes ever leave this module — only workspace-relative path strings,
// bounded to the deliverable allowlist. Ownership is per-conversation so the
// shared per-project `.trylo/out` can never leak another conversation's files
// into this capsule (H1 / R16).

import type { StoredWorkArtifact } from '../results/conversation-result-types';
import { scanWorkOutput } from '../results/work-artifact-scanner';

/** Deliverable extension allowlist (spec §2.2 rule 4), case-insensitive. */
const DELIVERABLE_EXT_RE = /\.(pptx|ppt|docx|xlsx|pdf|md|html|csv)$/i;

/** Whether a `.trylo/out` workspace-relative path is an allowed deliverable
 *  (shape AND extension). Shared by the listing and the collector so the two
 *  never disagree on the allowlist. */
export function isAllowlistedDeliverableRel(rel: string): boolean {
  return isWorkDeliverablePath(rel) && DELIVERABLE_EXT_RE.test(rel);
}

/**
 * List the allowlisted `.trylo/out` relative paths for a project root,
 * bounded to `budgetMs`. Uses `scanWorkOutput` (no symlinks followed, only
 * true regular files). A timeout or scan failure degrades to `[]` — never
 * throws and never blocks the run. Used for BOTH the start baseline and the
 * terminal listing (spec §2.2), so callers get the same traversal rules.
 */
export async function listAllowlistedOut(
  projectRoot: string,
  budgetMs = 1200,
): Promise<readonly string[]> {
  let outcome = null;
  try {
    outcome = await Promise.race([
      scanWorkOutput(projectRoot),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
  } catch {
    return [];
  }
  if (!outcome) return [];
  const paths: string[] = [];
  for (const artifact of outcome.artifacts) {
    if (artifact.target.kind !== 'file') continue;
    const rel = artifact.target.relativePath;
    if (!rel) continue;
    if (isAllowlistedDeliverableRel(rel)) paths.push(rel);
  }
  return paths;
}

/** Segments that make a `.trylo/out/**` path a staging/time-noise file — never
 *  a deliverable. */
const FORBIDDEN_SEGMENT_RE = /^(runtime|cache|attachments)$/;

/** Upper bound on how many hints cross the boundary (spec §2.2). */
export const MAX_FILE_HINTS = 40;

/**
 * Validate a `.trylo/out` deliverable by PATH SHAPE only (spec §2.6).
 *
 * Independent of content/extension — extension allowlisting happens separately
 * in `collectWorkFileHints`. Rules:
 *  1. reject NUL;
 *  2. POSIX-normalise (`\`→`/`, collapse `/`, strip leading `./`);
 *  3. any `..` or empty segment → reject;
 *  4. first two segments MUST be `.trylo` / `out` (so `.trylo/outbox` fails);
 *  5. any `runtime` / `cache` / `attachments` segment → reject.
 */
export function isWorkDeliverablePath(raw: string): boolean {
  if (raw.includes('\u0000')) return false;
  let p = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '' || p.startsWith('/')) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '..')) return false;
  if (segments[0] !== '.trylo' || segments[1] !== 'out') return false;
  // A deliverable has a filename: `.trylo/out` alone is the directory root.
  if (segments.length < 3) return false;
  for (const s of segments.slice(2)) {
    if (FORBIDDEN_SEGMENT_RE.test(s)) return false;
  }
  return true;
}

export interface WorkFileHintsInput {
  /** The conversation's Work result snapshot at terminal (its OWN store
   *  recognition — the per-conversation ownership proof, H1). */
  readonly snapshot: {
    readonly latestRun?: {
      readonly turnId: string;
      readonly createdIds: readonly string[];
      readonly updatedIds: readonly string[];
      readonly discoveredIds: readonly string[];
    };
    readonly artifacts: readonly StoredWorkArtifact[];
  };
  readonly turnId: string;
  /** OnRunStarted allowlisted `.trylo/out` relative paths (this turn's
   *  baseline). */
  readonly baselineRelPaths: readonly string[];
  /** Allowlisted `.trylo/out` relative paths listed AFTER terminal. Always
   *  done, regardless of whether the snapshot is empty. */
  readonly terminalRelPaths: readonly string[];
}

/** Which capture signal produced a candidate. `'new'` (rule 2, baseline diff)
 *  outranks `'delta'` (rule 1, snapshot delta) — the spec's dedup rule. */
type HintSource = 'new' | 'delta';

/**
 * Collect the fileHints for a finished Work turn (spec §2.2).
 *
 * Union (dedup, cap 40):
 *  1. snapshot delta — a file artifact this turn touched;
 *  2. baseline diff (mandatory) — appeared after terminal but not in the
 *     start baseline ⇒ "created this turn". Rule 2 wins over rule 1.
 *
 * Then each candidate must pass `isWorkDeliverablePath` (shape) AND the
 * extension allowlist AND — for BOTH capture rules — a per-conversation
 * ownership check: the file must already be recognised by THIS conversation's
 * store from an EVENTED run (`sources` contains `'event'`). Scan/recovery-
 * sourced records are corroboration, never ownership — the projector's own
 * isolation principle (`scopeScan`: the EVENT path is conversation-scoped and
 * authoritative; the scan only corroborates). On the recovery path (no event
 * evidence at all — a crash-recovered or first scan-less run) NOTHING is
 * provably ours, so hints fail closed to `[]` (H1/R16) instead of claiming
 * the whole shared `.trylo/out` the recovery scan ingested.
 */
export function collectWorkFileHints(input: WorkFileHintsInput): readonly string[] {
  const { snapshot, turnId, baselineRelPaths, terminalRelPaths } = input;
  const latestRun = snapshot.latestRun;

  // Per-conversation ownership proof (H1/R16): only files THIS conversation's
  // own evented runs recorded count as ours. `scan` / `recovery` sources come
  // from the whole-project `.trylo/out` sweep, which ingests EVERY
  // conversation's files — on the recovery path (no event evidence) the
  // snapshot is the full shared directory, and trusting it is exactly the
  // cross-conversation leak the projector's `scopeScan` exists to prevent.
  const owned = new Set<string>();
  let anyEventOwned = false;
  for (const a of snapshot.artifacts) {
    if (a.target.kind !== 'file') continue;
    if (!a.sources?.includes('event')) continue;
    anyEventOwned = true;
    owned.add(a.target.relativePath);
  }

  const baseline = new Set(baselineRelPaths);
  const candidates = new Map<string, HintSource>();

  // Recovery fail-closed (H1/R16): with zero evented ownership evidence the
  // snapshot came from a whole-project recovery scan — nothing in it is
  // provably THIS conversation's, and both capture rules would otherwise
  // claim other conversations' files (rule 1 because `finishRun` stamped
  // them `lastTurnId = this turn`). No event evidence ⇒ no hints at all.
  if (!anyEventOwned) return [];

  // Rule 1: this turn's snapshot delta.
  if (latestRun && latestRun.turnId === turnId) {
    const thisTurn = new Set([
      ...latestRun.createdIds,
      ...latestRun.updatedIds,
      ...latestRun.discoveredIds,
    ]);
    for (const a of snapshot.artifacts) {
      if (a.target.kind !== 'file') continue;
      if (a.lastTurnId !== turnId && !thisTurn.has(a.id)) continue;
      const path = a.target.relativePath;
      // Rule 1 inherits the same ownership proof as rule 2: a recovery-
      // ingested foreign file is stamped with this turn's id, so the delta
      // signal alone proves nothing. Evented ownership is checked below.
      // A path already claimed as `'new'` by rule 2 keeps that priority.
      if (!candidates.has(path) || candidates.get(path) !== 'new') {
        candidates.set(path, 'delta');
      }
    }
  }

  // Rule 2 (mandatory baseline diff): terminal − baseline = created this turn.
  for (const path of terminalRelPaths) {
    if (baseline.has(path)) continue;
    // Rule 2 outranks rule 1 regardless of arrival order.
    candidates.set(path, 'new');
  }

  const hints: string[] = [];
  for (const [path] of candidates) {
    if (!isWorkDeliverablePath(path)) continue;
    if (!DELIVERABLE_EXT_RE.test(path)) continue;
    // Ownership (H1): EVERY candidate must be provably ours (evented), not
    // just baseline-diff ones — a `'delta'` file can equally be a foreign
    // file stamped into our snapshot by a recovery scan.
    if (!owned.has(path)) continue;
    hints.push(path);
  }

  // Deterministic order: `new` (rule 2) before `delta` (rule 1), then by path
  // so the truncated set is stable. Cap at 40 (spec §2.2).
  hints.sort((a, b) => {
    const sa = candidates.get(a);
    const sb = candidates.get(b);
    if (sa !== sb) return sa === 'new' ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return hints.slice(0, MAX_FILE_HINTS);
}

/**
 * Map a source filename to an ASCII, extension-preserving delimiter slug
 * (spec §2.7). Used for the SKILL `templates/<slug>` pointer target, which is
 * always ASCII on disk (Chinese lives in SKILL.md text only). Returns null for
 * input with no usable ASCII base. Non-ASCII runs collapse to the extension, so
 * callers should prefer a class-level slug (weekly-report) rather than a
 * Chinese instance filename.
 */
export function deliverableSlug(raw: string): string | null {
  if (!raw) return null;
  const ext = raw.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  let base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  base = base.replace(/\.[^.]+$/, '');
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return null;
  return ext ? `${base}.${ext}` : base;
}

/** Typed convenience mirror of `StoredWorkResult` for the snapshot parameter.
 *  Keeps callers (work-lifecycle) from importing the full result type. */
export type FileHintsSnapshot = WorkFileHintsInput['snapshot'];