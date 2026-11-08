import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { CollaborationArchiveV2, CollaborationCycleV2, CollaborationV2Fact } from "./v2-contracts.js";
import { collaborationEvidenceClosureV2 } from "./v2-evidence.js";
import { isCollaborationPracticeV2 } from "./v2-parse.js";

export const COLLABORATION_HOT_TRIGGER = 2048;
const RECENT_FACTS = 128;
const RECENT_FAMILIES = 32;
const RECENT_PENDING_CYCLES = 8;

/** Raw archived facts remain in the Board's checksummed append log, inside the explicit compaction event. */
export function compactCollaborationProjectionV2(state: BoardState, scope: string, at: string, pinned: readonly string[] = [], mode: "normal" | "cold" = "normal") {
  const all = state.collaborationV2Facts ?? [], facts = all.filter(f => f.scope === scope);
  const roots = new Set([...(mode === "cold" ? [] : facts.slice(-RECENT_FACTS).map(f => f.factId)), ...pinned]);

  for (const f of facts) if (f.kind === "correction") roots.add(f.factId);

  const families = new Map<string, typeof state.assets[number]>();

  for (const asset of state.assets) if (asset.scope === scope && isCollaborationPracticeV2(asset.content)) families.set(asset.content.familyId, asset);

  for (const asset of mode === "cold" ? [] : [...families.values()].slice(-RECENT_FAMILIES)) if (isCollaborationPracticeV2(asset.content)) {
    for (const id of [...asset.content.sourceEventIds, ...asset.content.sourceEpisodeIds, ...asset.content.sourceOutcomeIds]) roots.add(id);

    for (const f of facts) if (f.kind === "analysis" && f.cycleId === asset.content.cycleId && f.sourceWindowHash === asset.content.sourceWindowHash) roots.add(f.factId);

    const exposures = new Set(facts.filter(f => f.kind === "exposure" && f.versionId === asset.versionId).map(f => f.factId));
    const adoptions = new Set(facts.filter(f => f.kind === "adoption" && exposures.has(f.exposureId)).map(f => f.factId));
    const negative = facts.filter(f => f.kind === "outcome" && (f.source === "external_checker" || f.source === "user")
      && f.metrics.delivery === "failed" && f.adoptionIds.some(id => adoptions.has(id))).at(-1);
    if (negative !== undefined) roots.add(negative.factId);
  }

  const heads = new Map<string, CollaborationCycleV2>();

  for (const f of facts) if (f.kind === "cycle") heads.set(f.cycleId, f);

  const pending = [...heads.values()].filter(f => ["running", "reserved", "waiting_evidence"].includes(f.phase));

  for (const head of mode === "cold" ? [] : pending.slice(-RECENT_PENDING_CYCLES)) roots.add(head.factId);

  for (const head of pending) if (head.phase === "reserved" && (head.claimExpiresAt === undefined || Date.parse(head.claimExpiresAt) > Date.parse(at))) roots.add(head.factId);

  const keep = retainedClosure(facts, roots);
  const removed = facts.filter(f => !keep.has(f.factId));
  if (removed.length === 0) return undefined;

  const previous = state.collaborationV2Archives?.find(a => a.scope === scope);
  const positions = factPositionsV2(state);
  const through = previous?.throughSequence ?? 0;
  const delta = usageDelta(facts, positions, through);
  const totalFactCount = (previous?.totalFactCount ?? 0) + facts.filter(f => (positions.get(f.factId) ?? 0) > through).length;
  const archive: CollaborationArchiveV2 = { schemaVersion: 1, scope, throughSequence: state.sequence, totalFactCount,
    archivedFactCount: totalFactCount - keep.size, recordedAt: at,
    learningCursor: Math.max(previous?.learningCursor ?? 0, ...[...heads.values()].map(h => h.cursor)),
    archiveDigest: contentHashOf({ before: previous?.archiveDigest ?? "none", through: state.sequence,
      records: removed.map(f => ({ factId: f.factId, contentHash: contentHashOf(f) })) }),
    usage: { modelCalls: (previous?.usage.modelCalls ?? 0) + delta.modelCalls,
      chargedTokens: (previous?.usage.chargedTokens ?? 0) + delta.chargedTokens,
      reportedTokens: (previous?.usage.reportedTokens ?? 0) + delta.reportedTokens,
      reportedCalls: (previous?.usage.reportedCalls ?? 0) + delta.reportedCalls } };

  return { facts: all.filter(f => f.scope !== scope || keep.has(f.factId)), removed, archive,
    archives: [...(state.collaborationV2Archives ?? []).filter(a => a.scope !== scope), archive] };
}

function retainedClosure(facts: readonly CollaborationV2Fact[], initial: ReadonlySet<string>): ReadonlySet<string> {
  const ids = new Set(initial), byCycle = new Map<string, CollaborationCycleV2[]>();

  for (const f of facts) if (f.kind === "cycle") byCycle.set(f.cycleId, [...(byCycle.get(f.cycleId) ?? []), f]);

  for (;;) {
    const before = ids.size;

    for (const f of collaborationEvidenceClosureV2(facts, [...ids])) ids.add(f.factId);

    for (const f of facts) if (ids.has(f.factId)) {
      if (f.kind === "analysis") {
        for (const id of [...f.basis.eventIds, ...f.basis.episodeIds, ...f.basis.outcomeIds, ...f.basis.exposureIds, ...f.basis.adoptionIds]) ids.add(id);
        for (const cycle of byCycle.get(f.cycleId) ?? []) ids.add(cycle.factId);
      }
      if (f.kind === "cycle") {
        for (const id of f.pinnedFactIds ?? []) ids.add(id);
        for (const cycle of byCycle.get(f.cycleId) ?? []) ids.add(cycle.factId);
        if (f.phase === "reserved" && byCycle.get(f.cycleId)?.at(-1)?.factId === f.factId) for (const analysis of facts) if (analysis.kind === "analysis" && analysis.cycleId === f.cycleId && analysis.step === f.step) ids.add(analysis.factId);
      }
    }

    if (ids.size === before) return new Set(facts.filter(f => ids.has(f.factId)).map(f => f.factId));
  }
}

export function factPositionsV2(state: BoardState): ReadonlyMap<string, number> {
  return new Map(state.appliedCommands.filter(c => c.commandId.startsWith("collaboration-v2:"))
    .map(c => [c.commandId.slice("collaboration-v2:".length), c.sequence]));
}

function usageDelta(facts: readonly CollaborationV2Fact[], positions: ReadonlyMap<string, number>, watermark: number) {
  const heads = new Map<string, CollaborationCycleV2>(), bases = new Map<string, CollaborationCycleV2>();
  const measurements = new Map<string, { readonly sequence: number; readonly tokens: number }>();

  for (const f of facts) {
    const sequence = positions.get(f.factId) ?? 0;

    if (f.kind === "cycle") {
      heads.set(f.cycleId, f);
      if (sequence <= watermark) bases.set(f.cycleId, f);
    }

    const usage = f.kind === "analysis" ? f.result.usage : f.kind === "cycle" ? f.usage : undefined;
    if ((f.kind === "analysis" || f.kind === "cycle") && usage?.status === "reported" && usage.totalTokens !== undefined) {
      const key = `${f.cycleId}\u0000${f.step}`, before = measurements.get(key);
      if (before === undefined || sequence < before.sequence) measurements.set(key, { sequence, tokens: usage.totalTokens });
    }
  }

  let modelCalls = 0, chargedTokens = 0;

  for (const [id, head] of heads) {
    const base = bases.get(id);
    modelCalls += head.spent.modelCalls - (base?.spent.modelCalls ?? 0);
    chargedTokens += head.spent.modelTokens - (base?.spent.modelTokens ?? 0);
  }

  const fresh = [...measurements.values()].filter(m => m.sequence > watermark);

  return { modelCalls, chargedTokens, reportedTokens: fresh.reduce((sum, m) => sum + m.tokens, 0), reportedCalls: fresh.length };
}

/** Archive totals already include hot heads through their watermark; add only subsequent deltas. */
export function collaborationUsageTotalsV2(state: BoardState, scope: string) {
  const archive = state.collaborationV2Archives?.find(a => a.scope === scope);
  const delta = usageDelta((state.collaborationV2Facts ?? []).filter(f => f.scope === scope), factPositionsV2(state), archive?.throughSequence ?? 0);
  return { modelCalls: (archive?.usage.modelCalls ?? 0) + delta.modelCalls, chargedTokens: (archive?.usage.chargedTokens ?? 0) + delta.chargedTokens,
    reportedTokens: (archive?.usage.reportedTokens ?? 0) + delta.reportedTokens, reportedCalls: (archive?.usage.reportedCalls ?? 0) + delta.reportedCalls };
}

export function validCollaborationArchivesV2(value: unknown): value is readonly CollaborationArchiveV2[] {
  if (!Array.isArray(value)) return false;

  const scopes = new Set<string>();

  for (const v of value) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;

    const a = v as Record<string, unknown>, usage = a.usage;
    if (a.schemaVersion !== 1 || typeof a.scope !== "string" || !a.scope || scopes.has(a.scope) || typeof a.archiveDigest !== "string"
      || typeof a.recordedAt !== "string" || !Number.isFinite(Date.parse(a.recordedAt))
      || ![a.throughSequence, a.totalFactCount, a.archivedFactCount, a.learningCursor].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      || typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;

    const u = usage as Record<string, unknown>;
    if (Object.keys(a).some(k => !["schemaVersion", "scope", "throughSequence", "totalFactCount", "archivedFactCount", "learningCursor", "archiveDigest", "recordedAt", "usage"].includes(k))
      || Object.keys(u).length !== 4 || ![u.modelCalls, u.chargedTokens, u.reportedTokens, u.reportedCalls].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return false;

    scopes.add(a.scope);
  }

  return true;
}
