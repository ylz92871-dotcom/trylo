// Preference scorer stub (PR-6, spec §12 — Latent Preference Model is
// an INPUT only). No neural runtime exists today
// (user-learning/preference/ is future work); this symbolic stub keeps
// the interface shape so an ONNX-backed scorer can replace it without
// touching EngineeringContract. Invariants:
//   - never pretends uncertainty 'low' (no posterior exists)
//   - never reads PolicyRule and never reads Conclusions as samples
//   - no network I/O; no safety adjudication (that is the Governor's job)
import type { TaskContext, UserLearningSnapshot } from '../types';
import type { PreferenceScore } from './spawn-score';

export interface PreferenceCandidate {
  readonly id: string;
  readonly label: string;
  readonly factors?: Readonly<Record<string, number>>;
}

export interface PreferenceScorer {
  /** Score legal candidates. No safety adjudication; no network I/O. */
  score(input: {
    readonly task: TaskContext;
    readonly snapshot: UserLearningSnapshot;
    readonly candidates: readonly PreferenceCandidate[];
  }): PreferenceScore;
}

const DIMENSION_HINTS: readonly { readonly dimension: string; readonly re: RegExp }[] = [
  { dimension: 'verification_audit', re: /验证|审核|test|review|verify/i },
  { dimension: 'planning_direct_execution', re: /直接|计划|plan|先做/i },
  { dimension: 'architecture_refactor', re: /架构|重构|抽象|refactor/i },
];

function matchedDimensions(task: TaskContext): readonly string[] {
  const text = `${task.prompt} ${task.explicitInstruction}`;
  return DIMENSION_HINTS.filter((h) => h.re.test(text)).map((h) => h.dimension);
}

/**
 * Symbolic stub: ranks candidates by a coarse User-Model dimension
 * match. uncertainty is 'medium' only with a D0 high-confidence UM,
 * otherwise 'high' — never 'low'.
 */
export function createSymbolicPreferenceScorer(): PreferenceScorer {
  return {
    score(input: {
      readonly task: TaskContext;
      readonly snapshot: UserLearningSnapshot;
      readonly candidates: readonly PreferenceCandidate[];
    }): PreferenceScore {
      try {
        const dims = new Set(matchedDimensions(input.task));
        const relevant = input.snapshot.userModels.filter(
          (m) => m.status === 'active' && dims.has(m.dimension),
        );
        const hasStrongAnchor = relevant.some(
          (m) => m.inference.distance === 'D0' && m.confidence.band === 'high',
        );
        const count = (candidate: PreferenceCandidate): number => {
          let weight = 0;
          for (const m of relevant) {
            if (candidate.factors?.[m.dimension] !== undefined) {
              weight += candidate.factors[m.dimension]! * m.confidence.score;
            } else {
              weight += m.confidence.score * 0.1;
            }
          }
          return weight;
        };
        const ranked = [...input.candidates]
          .map((c) => ({ id: c.id, weight: count(c) }))
          .sort((a, b) => b.weight - a.weight);
        const total = ranked.reduce((sum, r) => sum + r.weight, 0);
        const ranking = ranked.map((r) => ({
          id: r.id,
          probability: total > 0 ? r.weight / total : 1 / Math.max(1, ranked.length),
        }));
        return {
          ranking,
          uncertainty: hasStrongAnchor ? 'medium' : 'high',
          scopeFit: relevant.length > 0 ? 'medium' : 'low',
          relevantObservations: relevant.length,
          source: 'stub_symbolic',
        };
      } catch {
        // Failure mode §19: stub throwing ⇒ uncertainty high, no crash.
        return {
          ranking: input.candidates.map((c) => ({ id: c.id, probability: 1 / Math.max(1, input.candidates.length) })),
          uncertainty: 'high',
          scopeFit: 'low',
          relevantObservations: 0,
          source: 'stub_symbolic',
        };
      }
    },
  };
}

/** Governor candidates for one spawn decision (never enters seat prompts). */
export function spawnCandidates(): readonly PreferenceCandidate[] {
  return [
    { id: 'solo_direct', label: 'Stay solo, direct execution' },
    { id: 'team_worker_reviewer', label: 'Team with worker + reviewer' },
    { id: 'team_full', label: 'Full five-seat team' },
    { id: 'ask_user', label: 'Ask the user first' },
  ];
}
