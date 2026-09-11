// Trylo Desktop — pending-origin helper (PR-5 / PR-6).
// localStorage map from pending item id → origin record with copyPlan info,
// including `skillName` from the pending target. Written when the pending
// proposal is created, read by PendingProposals.tsx to show the target context
// and to drive the apply-time template copy (PR-6).
// Damaged origin JSON → chip shows "实时" (PR-5).
//
// PR-6 contract (spec §2.8 / §6):
//   - FIFO 200: the map may never exceed 200 entries; the OLDEST entry is
//     evicted on insert — BUT an id that `listPending` still returns is
//     never evicted (the pending queue is the authoritative "still relevant"
//     signal). Since the renderer only inserts/evicts in response to a live
//     `listPending` snapshot, we evict only entries whose id is not in the
//     provided live set.
//
// KEY: 'trylo:learning:pending:origin:v1'

const PENDING_ORIGIN_KEY = 'trylo:learning:pending:origin:v1';
const MAX_PENDING_ORIGIN_ENTRIES = 200;

export interface PendingOriginRecord {
  readonly origin: string;
  /** Human-readable source — e.g. "提升产物", "周报.pptx", "做成模板". */
  readonly label: string;
  /** The `.trylo/out` relative path of the deliverable (copyPlan sourceRel).
   *  Absent → PR-6 skips the copy (no source). */
  readonly sourceRel?: string;
  /** The skill name extracted from the pending target, to be written into
   *  the copyPlan of the originating proposal. PR-6: absent → skip copy. */
  readonly skillName?: string;
  /** Expected size in bytes captured at review time (optional; the sidecar
   *  always enforces the 20 MiB / symlink / allowlist guards regardless). */
  readonly bytes?: number;
  /** Expected mtime in ms captured at review time (optional drift guard). */
  readonly mtimeMs?: number;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly workspaceRoot?: string;
  readonly at?: number;
  readonly createdAt: number;
}

export function loadPendingOrigins(): Record<string, PendingOriginRecord> {
  try {
    const raw = localStorage.getItem(PENDING_ORIGIN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, PendingOriginRecord>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Save one origin record. Keeps the map bounded to MAX_PENDING_ORIGIN_ENTRIES
 *  by evicting the oldest entries — never an id still present in the live
 *  pending set (spec §2.8). Returns the resulting map. */
export function savePendingOrigin(id: string, record: PendingOriginRecord, liveIds: ReadonlySet<string> = new Set()): void {
  try {
    const all = loadPendingOrigins();
    all[id] = record;
    const ids = Object.keys(all);
    if (ids.length > MAX_PENDING_ORIGIN_ENTRIES) {
      // Evict oldest (by createdAt, tie → insertion order) skipping live ids.
      const order = ids
        .map((key) => ({ key, at: all[key]?.createdAt ?? 0 }))
        .sort((a, b) => a.at - b.at);
      for (const { key } of order) {
        if (ids.length <= MAX_PENDING_ORIGIN_ENTRIES) break;
        if (liveIds.has(key)) continue;
        delete all[key];
        ids.splice(ids.indexOf(key), 1);
      }
    }
    localStorage.setItem(PENDING_ORIGIN_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable → ignore.
  }
}

export function getPendingOrigin(id: string): PendingOriginRecord | null {
  const all = loadPendingOrigins();
  return all[id] ?? null;
}

export function removePendingOrigin(id: string): void {
  try {
    const all = loadPendingOrigins();
    delete all[id];
    localStorage.setItem(PENDING_ORIGIN_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

/** Extract the `skillName` from a pending proposal's target. Called when the
 *  detail is first loaded. Returns undefined if the target has no name, so
 *  PR-6 will not copy it. */
export function extractSkillNameFromTarget(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const rec = target as Record<string, unknown>;
  // Try several common locations for the name.
  if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
  if (typeof rec.skillName === 'string' && rec.skillName.trim()) return rec.skillName.trim();
  if (typeof rec.skill_name === 'string' && rec.skill_name.trim()) return rec.skill_name.trim();
  if (typeof rec.title === 'string' && rec.title.trim()) return rec.title.trim();
  return undefined;
}