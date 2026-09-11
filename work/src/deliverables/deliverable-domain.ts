// Trylo Work — Deliverable workflow domain types.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §8.4,
// §8.7, §11.3): the vendor-agnostic contract for a
// deliverable-aware workflow. A PhaseRail only answers
// "which stage"; these types answer "how far is the WORK
// itself" (spec §8.1) — brief → sources → outline → visual
// direction → unit generation → preview → QA → export.
//
// Hard honesty rules baked into the shapes (spec §8.4 /
// §16):
//   - `requestedSlideCount` is the USER'S ask; it never
//     masquerades as the actual page count;
//   - a slide unit only advances on generator / renderer /
//     validator FACTS — never on assistant prose;
//   - a visual check that was never run is `not_run`,
//     never a green pass.
//
// Pure: no React, no I/O. Importable from browser builds.

/** Spec §8.4: the deliverable families. PPT pilots first;
 *  the registry keeps the framework extensible (§8.9). */
export type WorkDeliverableKind =
  | "presentation"
  | "document"
  | "spreadsheet"
  | "website"
  | "research"
  | "generic";

/** One stage on the deliverable axis (spec §8.1). */
export interface DeliverableMilestoneDefinition {
  readonly id: string;
  readonly label: string;
}

/** A user-decision node (spec §8.8): content direction,
 *  NOT a permission approval. */
export interface DeliverableCheckpointDefinition {
  readonly id: string;
  readonly label: string;
  /** Which milestone the checkpoint gates. */
  readonly afterMilestone: string;
}

/** A QA capability (spec §8.5 G). */
export interface DeliverableValidatorDefinition {
  readonly id: string;
  readonly label: string;
  /** `structure` = parse/zip-level checks we can always
   *  run; `visual` = needs a real renderer — without one
   *  the result MUST be `not_run`. */
  readonly kind: "structure" | "visual";
}

export type DeliverablePreviewStrategy =
  | "none"
  | "file"
  | "thumbnail-grid"
  | "browser";

/** Spec §8.4: what a deliverable family promises. The UI
 *  renders from this + the projection; it never hardcodes
 *  a per-kind layout (§8.9 "禁止每种交付物各写一套"). */
export interface DeliverableWorkflowDefinition {
  readonly kind: WorkDeliverableKind;
  readonly milestones: readonly DeliverableMilestoneDefinition[];
  readonly unitType?: "slide" | "section" | "sheet" | "page" | "record";
  readonly checkpoints: readonly DeliverableCheckpointDefinition[];
  readonly validators: readonly DeliverableValidatorDefinition[];
  readonly previewStrategy: DeliverablePreviewStrategy;
}

// ---------------------------------------------------------------------------
// Presentation projection (spec §8.4, verbatim field policy).
// ---------------------------------------------------------------------------

export type PresentationBriefStatus = "collecting" | "ready" | "confirmed";

export interface PresentationBrief {
  readonly purpose?: string;
  readonly audience?: string;
  readonly durationMinutes?: number;
  /** The USER'S requested page count — never the actual
   *  count (spec §8.4). */
  readonly requestedSlideCount?: number;
  readonly tone?: string;
  readonly language?: string;
  readonly status: PresentationBriefStatus;
}

export type PresentationSourceStatus =
  | "queued"
  | "reading"
  | "used"
  | "failed";

export interface PresentationSource {
  readonly id: string;
  readonly label: string;
  readonly uri?: string;
  readonly status: PresentationSourceStatus;
  readonly citationCount?: number;
}

export type PresentationOutlineStatus =
  | "draft"
  | "awaiting_review"
  | "approved"
  | "superseded";

export interface PresentationOutlineSlide {
  readonly index: number;
  readonly title: string;
  readonly intent?: string;
}

export interface PresentationOutline {
  readonly version: number;
  readonly status: PresentationOutlineStatus;
  readonly slides: readonly PresentationOutlineSlide[];
}

export type PresentationVisualMode =
  | "work"
  | "editorial"
  | "playful"
  | "premium"
  | "technical";

export type PresentationImagePolicy =
  | "none"
  | "placeholders"
  | "reuse"
  | "generate"
  | "mixed";

export interface PresentationVisualDirection {
  readonly mode?: PresentationVisualMode;
  readonly templateName?: string;
  readonly brandName?: string;
  readonly imagePolicy?: PresentationImagePolicy;
  readonly status: "draft" | "selected";
}

/** Honest unit status ladder (spec §8.4 / §8.5 E): a unit
 *  only moves forward on real facts. `generating` is the
 *  ceiling while the whole-deck generator runs without a
 *  per-page callback — no `4 / 10` fiction. */
export type PresentationSlideStatus =
  | "queued"
  | "content_ready"
  | "visual_ready"
  | "generating"
  | "rendered"
  | "validated"
  | "issue";

export interface PresentationSlideUnit {
  readonly index: number;
  readonly title: string;
  readonly status: PresentationSlideStatus;
  readonly previewPath?: string;
  readonly issues?: readonly string[];
}

export type DeliverableValidationStatus =
  | "pending"
  | "running"
  | "passed"
  | "warning"
  | "failed"
  /** The check needs a capability (a renderer) that is not
   *  packaged — it was NEVER run. Never displayed green
   *  (spec §8.5 G-8 / §16-14). */
  | "not_run";

export interface DeliverableValidationEntry {
  readonly id: string;
  readonly label: string;
  readonly status: DeliverableValidationStatus;
  readonly evidence?: string;
}

export interface PresentationExport {
  readonly format: "pptx" | "pdf" | "preview";
  readonly path: string;
}

/** The live projection of ONE presentation deliverable
 *  (spec §8.4). Immutable; the reducer returns fresh
 *  copies. */
export interface PresentationWorkflowProjection {
  readonly kind: "presentation";
  readonly deliverableId: string;
  readonly brief: PresentationBrief;
  readonly sources: readonly PresentationSource[];
  readonly outline?: PresentationOutline;
  readonly visualDirection?: PresentationVisualDirection;
  readonly slides: readonly PresentationSlideUnit[];
  readonly validation: readonly DeliverableValidationEntry[];
  readonly exports: readonly PresentationExport[];
  /** True while the whole-deck generator call is in
   *  flight. The panel may only say "正在生成 N 页" — page
   *  progress stays hidden until real per-page facts
   *  arrive (spec §8.5 E). */
  readonly generating: boolean;
  /** Revision linkage (spec §8.5 H): a follow-up "change
   *  page 4" run revises the same deliverable. */
  readonly revisionOf?: string;
  readonly outlineVersion?: number;
  readonly artifactVersion?: number;
}

// ---------------------------------------------------------------------------
// Minimal event protocol (spec §8.7).
// ---------------------------------------------------------------------------

/** The thin typed protocol the adapter emits and the
 *  projection reducer consumes. Zero vendor changes: the
 *  adapter derives these from the EXISTING raw event
 *  surface (`tool_call`, `tool_result`, artifact events,
 *  task lists) — or from future typed daemon events
 *  without a reducer change. */
export type DeliverableWorkflowEvent =
  | { readonly type: "deliverable.detected"; readonly deliverableId: string; readonly kind: WorkDeliverableKind }
  | { readonly type: "deliverable.brief.updated"; readonly deliverableId: string; readonly brief: Partial<PresentationBrief> }
  | { readonly type: "deliverable.source.updated"; readonly deliverableId: string; readonly source: PresentationSource }
  | { readonly type: "deliverable.outline.updated"; readonly deliverableId: string; readonly outline: PresentationOutline }
  | { readonly type: "deliverable.checkpoint.requested"; readonly deliverableId: string; readonly checkpointId: string }
  | { readonly type: "deliverable.style.selected"; readonly deliverableId: string; readonly style: PresentationVisualDirection }
  | { readonly type: "deliverable.generation.started"; readonly deliverableId: string; readonly totalUnits?: number }
  | { readonly type: "deliverable.generation.finished"; readonly deliverableId: string; readonly ok: boolean }
  | { readonly type: "deliverable.unit.updated"; readonly deliverableId: string; readonly unit: PresentationSlideUnit }
  | { readonly type: "deliverable.preview.ready"; readonly deliverableId: string; readonly index: number; readonly previewPath: string }
  | { readonly type: "deliverable.validation.updated"; readonly deliverableId: string; readonly check: DeliverableValidationEntry }
  | { readonly type: "deliverable.exported"; readonly deliverableId: string; readonly artifact: PresentationExport };

/** A deliverable projection the turn carries (spec §11.3
 *  `WorkTurnProjection.deliverables`). One family today;
 *  the union grows with §8.9 families. */
export type WorkDeliverableProjection =
  | PresentationWorkflowProjection;

// ---------------------------------------------------------------------------
// Fact boundary (spec §8.7 step 1: zero vendor changes).
// ---------------------------------------------------------------------------

/** The raw-ish facts the presenter forwards to the
 *  deliverable adapter. Derived ONLY from the existing
 *  daemon event surface (`tool_call` / `tool_result`); the
 *  presenter gates emission on the deliverable generator
 *  tool allowlist so unrelated tool traffic never enters
 *  this channel. Shapes are defensive — every field is
 *  optional at the parsing layer. */
export type DeliverableFactBody =
  | {
      readonly type: "tool_call";
      readonly tool: string;
      /** The generator's real input (slides, audience…).
       *  Untyped on purpose: the adapter parses it
       *  defensively, never the UI. */
      readonly input?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_result";
      readonly tool: string;
      readonly ok: boolean;
    };
