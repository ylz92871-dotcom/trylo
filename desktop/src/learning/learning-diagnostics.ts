// Trylo Desktop — Learning diagnostics sink.
// TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §Observability.
//
// A single, template-less structure for the Work-surface Hermes wiring's
// diagnostics. It intentionally does NOT reuse the Code controller's
// `DiagEventType` and does NOT make `CodeRunController` a writer of learning
// events: learning is an independent plane and must stay independently
// observable and testable.
//
// Privacy contract (spec §Security / §Observability): the exported JSON must
// never contain `taskGoal`, `resultText`, or absolute paths. Any path carried
// on a diagnostic is redacted to `.trylo/out/<basename>` before it is
// recorded.

export type LearningDiagnosticType =
  | 'learning.work_mirror_ok'
  | 'learning.work_mirror_fail'
  | 'learning.work_review_triggered'
  | 'learning.work_review_skipped'
  | 'learning.learn_explicit_skipped'
  | 'learning.cognition_prompt_shown'
  | 'learning.evidence_extracted'
  | 'learning.template_copy';

export type LearningDiagnosticProduct = 'code' | 'work';

export interface LearningDiagnosticEvent {
  readonly type: LearningDiagnosticType;
  readonly reasonCode?: string;
  readonly product?: 'code' | 'work';
  readonly channel?: string;
  /** Diagnostics that carry a path must hand it PRE-redacted: the sink
   *  never receives an absolute path. Use `redactWorkPath` to safe-format. */
  readonly path?: string;
  readonly at?: number;
}

export interface LearningDiagnosticsSink {
  record(event: LearningDiagnosticEvent): void;
}

/** Null sink — the default when no diagnostics are wired. Never throws. */
export function createNullLearningDiagnostics(): LearningDiagnosticsSink {
  const noop = (): void => undefined;
  return { record: noop };
}

/** Redact a workspace path to `.trylo/out/<basename>` for diagnostics.
 *  Returns null for everything that is not under some `.trylo/out` segment,
 *  so no absolute path can ever leak into a log/snapshot. */
export function redactWorkPath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/');
  const idx = normalized.indexOf('.trylo/out/');
  if (idx < 0) return null;
  const after = normalized.slice(idx + '.trylo/out/'.length);
  const basename = after.split('/').pop() ?? '';
  if (!basename) return null;
  return `.trylo/out/${basename}`;
}

/** In-memory sink that also serializes to JSON. Used by the testing harness
 *  and as the default diagnostic surface for the Work wiring. */
export function createLearningDiagnostics(
  sink?: (event: LearningDiagnosticEvent) => void,
): { readonly sink: LearningDiagnosticsSink; readonly exportJson: () => string } {
  const events: LearningDiagnosticEvent[] = [];
  return {
    sink: {
      record(event) {
        events.push(event);
        sink?.(event);
      },
    },
    exportJson: () => JSON.stringify(events.slice(-200)),
  };
}