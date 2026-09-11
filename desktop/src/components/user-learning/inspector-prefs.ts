// Persisted Inspector preferences (TRYLO-DUAL-SURFACE-SPEC §4.1).
//
// The panel is a dual-surface inspector: opening from a Code or Work surface
// defaults to the 用户认知 module filtered to that surface — never to an empty
// Hermes pending queue. Filters live only in component state + this
// localStorage key (not the URL).
//
// KEY: 'trylo:learning:inspector:v1'
import type {
  EvidenceRecord,
  PolicyDimension,
  ProductSurface,
  StrengthBand,
} from '../../user-learning/types';

export const INSPECTOR_PREFS_KEY = 'trylo:learning:inspector:v1';

export type InspectorModule = 'cognition' | 'agent';
export type SurfaceFilter = 'all' | ProductSurface;

export interface InspectorPrefs {
  readonly module: InspectorModule;
  readonly cognitionTab: 'status' | 'profile' | 'model' | 'evidence' | 'decisions';
  readonly agentTab: 'pending' | 'approved';
  readonly surfaceFilter: SurfaceFilter;
  readonly channelFilter: 'all' | 'work' | 'interaction' | 'cognition';
  readonly dimensionFilter: 'all' | PolicyDimension;
  readonly strengthFilter: 'all' | StrengthBand;
}

export const DEFAULT_INSPECTOR_PREFS: InspectorPrefs = {
  module: 'cognition',
  cognitionTab: 'status',
  agentTab: 'pending',
  surfaceFilter: 'all',
  channelFilter: 'all',
  dimensionFilter: 'all',
  strengthFilter: 'all',
};

/** Load prefs from localStorage; corrupted / unknown shape → defaults. */
export function loadInspectorPrefs(): InspectorPrefs {
  try {
    const raw = localStorage.getItem(INSPECTOR_PREFS_KEY);
    if (!raw) return DEFAULT_INSPECTOR_PREFS;
    const parsed = JSON.parse(raw) as Partial<InspectorPrefs>;
    return {
      module: parsed.module === 'agent' ? 'agent' : 'cognition',
      cognitionTab:
        parsed.cognitionTab === 'profile' || parsed.cognitionTab === 'model' || parsed.cognitionTab === 'evidence' || parsed.cognitionTab === 'decisions'
          ? parsed.cognitionTab
          : 'status',
      agentTab: parsed.agentTab === 'approved' ? 'approved' : 'pending',
      surfaceFilter: parsed.surfaceFilter === 'code' || parsed.surfaceFilter === 'work' ? parsed.surfaceFilter : 'all',
      channelFilter:
        parsed.channelFilter === 'work' || parsed.channelFilter === 'interaction' || parsed.channelFilter === 'cognition'
          ? parsed.channelFilter
          : 'all',
      dimensionFilter: typeof parsed.dimensionFilter === 'string' ? (parsed.dimensionFilter as PolicyDimension) : 'all',
      strengthFilter: parsed.strengthFilter === 'weak' || parsed.strengthFilter === 'medium' || parsed.strengthFilter === 'strong' || parsed.strengthFilter === 'authoritative'
        ? parsed.strengthFilter
        : 'all',
    };
  } catch {
    return DEFAULT_INSPECTOR_PREFS;
  }
}

export function saveInspectorPrefs(prefs: InspectorPrefs): void {
  try {
    localStorage.setItem(INSPECTOR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (e.g. non-persistent webview) → ignore.
  }
}

/** Defaults to the surface that opened the panel when no persisted prefs exist
 *  (spec §4.1). Falls back to `'all'` otherwise. */
export function defaultSurfaceFilter(openedFrom: ProductSurface | undefined, persisted: SurfaceFilter | undefined): SurfaceFilter {
  if (persisted) return persisted;
  return openedFrom ?? 'all';
}

/** Predicate for evidence `structured.dimension` (a raw `Record<unknown>`). */
function asPolicyDimension(value: unknown): PolicyDimension | undefined {
  return typeof value === 'string' ? (value as PolicyDimension) : undefined;
}

/** Evidence surface: from the scope product, defaulting to `'code'` (spec §4.2). */
export function evidenceSurface(e: EvidenceRecord): ProductSurface {
  return e.context?.product ?? 'code';
}

/** Pure filter over evidence rows for the Inspector list (spec §4.2).
 *  Applied before the 100-row cap; returns rows sorted by `createdAt` desc. */
export function filterEvidence(
  evidence: readonly EvidenceRecord[],
  prefs: Pick<InspectorPrefs, 'surfaceFilter' | 'channelFilter' | 'dimensionFilter' | 'strengthFilter'>,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const e of evidence) {
    if (prefs.surfaceFilter !== 'all' && evidenceSurface(e) !== prefs.surfaceFilter) continue;
    if (prefs.channelFilter !== 'all' && e.origin?.channel !== prefs.channelFilter) continue;
    if (prefs.dimensionFilter !== 'all') {
      const dim = asPolicyDimension(e.rawObservation?.structured?.dimension);
      if (dim !== prefs.dimensionFilter) continue;
    }
    if (prefs.strengthFilter !== 'all' && e.strength?.band !== prefs.strengthFilter) continue;
    out.push(e);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}