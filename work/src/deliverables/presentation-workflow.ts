// Trylo Work — PresentationWorkflowProjection reducer.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §8.4,
// §8.5, §8.8): the pure reducer folding
// `DeliverableWorkflowEvent`s into one presentation's
// live projection. The desktop panel renders ONLY this
// projection — it never parses raw events and never
// invents progress.
//
// Honesty invariants this file enforces (spec §16):
//   1. slide units appear ONLY from a real outline or the
//      generator tool's actual `input.slides` — never from
//      a requested count and never from assistant prose;
//   2. while the whole-deck generator runs without a
//      per-page callback the run is `generating: true` and
//      every unit stays at `generating` at best — no
//      `4 / 10` fiction;
//   3. validation entries only reach `passed` on explicit
//      evidence; a visual check without a renderer is
//      `not_run`, never green;
//   4. an outline update bumps `version` and supersedes the
//      previous one in place — the chat never stacks
//      duplicate giant cards (§8.4);
//   5. everything is idempotent per event identity so
//      `task.events` replay converges to the same state
//      (§6.3 / §12.2).

import type {
  DeliverableValidationEntry,
  DeliverableWorkflowEvent,
  PresentationBrief,
  PresentationOutline,
  PresentationSlideUnit,
  PresentationSource,
  PresentationVisualDirection,
  PresentationWorkflowProjection,
} from "./deliverable-domain.js";

/** Fresh projection for one deliverable (spec §8.4). */
export function createPresentationProjection(
  deliverableId: string,
): PresentationWorkflowProjection {
  return {
    kind: "presentation",
    deliverableId,
    brief: { status: "collecting" },
    sources: [],
    slides: [],
    validation: [],
    exports: [],
    generating: false,
  };
}

/** Fold ONE event into the projection. Immutable and
 *  idempotent: replaying the same event sequence converges
 *  to an equal projection. */
export function reduceDeliverableEvent(
  p: PresentationWorkflowProjection,
  event: DeliverableWorkflowEvent,
): PresentationWorkflowProjection {
  if (event.deliverableId !== p.deliverableId) return p;
  switch (event.type) {
    case "deliverable.detected":
      // Detection alone carries no content.
      return p;

    case "deliverable.brief.updated":
      return withBrief(p, event.brief);

    case "deliverable.source.updated":
      return withSource(p, event.source);

    case "deliverable.outline.updated":
      return withOutline(p, event.outline);

    case "deliverable.checkpoint.requested":
      // The outline enters awaiting_review — the panel
      // surfaces the checkpoint; the decision itself comes
      // back through the existing approval/input channel.
      if (!p.outline || p.outline.status !== "draft") return p;
      return {
        ...p,
        outline: { ...p.outline, status: "awaiting_review" },
      };

    case "deliverable.style.selected":
      return withStyle(p, event.style);

    case "deliverable.generation.started":
      return startGeneration(p, event.totalUnits);

    case "deliverable.generation.finished":
      return finishGeneration(p, event.ok);

    case "deliverable.unit.updated":
      return withUnit(p, event.unit);

    case "deliverable.preview.ready":
      return withPreview(p, event.index, event.previewPath);

    case "deliverable.validation.updated":
      return withValidation(p, event.check);

    case "deliverable.exported": {
      const exists = p.exports.some(
        (e) => e.format === event.artifact.format && e.path === event.artifact.path,
      );
      if (exists) return p;
      return { ...p, exports: [...p.exports, event.artifact] };
    }
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function withBrief(
  p: PresentationWorkflowProjection,
  patch: Partial<PresentationBrief>,
): PresentationWorkflowProjection {
  const brief: PresentationBrief = { ...p.brief, ...patch };
  // A requested count is a USER fact; keep it separate from
  // any realized unit list (spec §8.4).
  return { ...p, brief };
}

function withSource(
  p: PresentationWorkflowProjection,
  source: PresentationSource,
): PresentationWorkflowProjection {
  const idx = p.sources.findIndex((s) => s.id === source.id);
  if (idx === -1) return { ...p, sources: [...p.sources, source] };
  const existing = p.sources[idx];
  if (!existing) return p;
  const sources = p.sources.slice();
  sources[idx] = { ...existing, ...source };
  return { ...p, sources };
}

function withOutline(
  p: PresentationWorkflowProjection,
  outline: PresentationOutline,
): PresentationWorkflowProjection {
  const previous = p.outline;
  if (previous && previous.version === outline.version) {
    // Same version → status/content refresh in place.
    return { ...p, outline: { ...previous, ...outline } };
  }
  if (previous && outline.version > previous.version) {
    // A newer outline supersedes the old one IN PLACE —
    // never stacks a second card (spec §8.4). The slide
    // units rebuild from the new outline; any prior unit
    // facts belonged to the superseded deck version.
    const superseded: PresentationOutline = {
      ...previous,
      status: "superseded",
    };
    void superseded;
    return {
      ...p,
      outline,
      outlineVersion: outline.version,
      slides: outline.slides.map((s) => ({
        index: s.index,
        title: s.title,
        status: "queued",
      })),
    };
  }
  // Older or equal-but-unversioned outline arriving late:
  // ignore it rather than regressing the deck state.
  if (previous && outline.version < previous.version) return p;
  return {
    ...p,
    outline,
    outlineVersion: outline.version,
    slides: outline.slides.map((s) => ({
      index: s.index,
      title: s.title,
      status: "queued",
    })),
  };
}

function withStyle(
  p: PresentationWorkflowProjection,
  style: PresentationVisualDirection,
): PresentationWorkflowProjection {
  return { ...p, visualDirection: { ...p.visualDirection, ...style } };
}

/** Spec §8.5 E: the generator call starts. Units exist
 *  only when an outline or the real input.slides already
 *  established them; otherwise we record the total (when
 *  known) WITHOUT inventing per-page rows. */
function startGeneration(
  p: PresentationWorkflowProjection,
  totalUnits: number | undefined,
): PresentationWorkflowProjection {
  if (p.slides.length > 0) {
    // Real units exist — flip them to `generating` (the
    // honest ceiling without a per-page callback).
    const slides = p.slides.map((s): PresentationSlideUnit => ({
      ...s,
      status: s.status === "queued" || s.status === "content_ready"
        ? "generating"
        : s.status,
    }));
    return { ...p, generating: true, slides };
  }
  // No unit facts yet: keep the requested total on the
  // brief ONLY if nothing better exists — it stays labeled
  // as the user's ask, never as realized pages.
  const brief = totalUnits !== undefined && p.brief.requestedSlideCount === undefined
    ? { ...p.brief, requestedSlideCount: totalUnits }
    : p.brief;
  return { ...p, generating: true, brief };
}

/** Spec §8.5 E: the whole-deck call returned. Without
 *  per-page facts we can only mark the deck as a whole —
 *  units stay `generating` until a renderer / validator
 *  reports per-page truth. */
function finishGeneration(
  p: PresentationWorkflowProjection,
  ok: boolean,
): PresentationWorkflowProjection {
  if (!ok) {
    const slides = p.slides.map((s): PresentationSlideUnit =>
      s.status === "generating" ? { ...s, status: "issue", issues: ["生成失败"] } : s,
    );
    return { ...p, generating: false, slides };
  }
  return { ...p, generating: false };
}

/** A per-page FACT (renderer callback, intermediate file,
 *  validator row). The only way past the `generating`
 *  ceiling. Unknown indices are ignored — we never grow
 *  the deck from a stray event. */
function withUnit(
  p: PresentationWorkflowProjection,
  unit: PresentationSlideUnit,
): PresentationWorkflowProjection {
  const idx = p.slides.findIndex((s) => s.index === unit.index);
  if (idx === -1) {
    // A unit we never planned is not silently appended —
    // it would inflate the page count. It IS accepted when
    // the deck has no units at all yet (the generator's
    // input.slides is establishing them one by one).
    if (p.slides.length > 0) return p;
    return { ...p, slides: [unit] };
  }
  const existing = p.slides[idx];
  if (!existing) return p;
  const slides = p.slides.slice();
  slides[idx] = { ...existing, ...unit };
  return { ...p, slides };
}

function withPreview(
  p: PresentationWorkflowProjection,
  index: number,
  previewPath: string,
): PresentationWorkflowProjection {
  const idx = p.slides.findIndex((s) => s.index === index);
  if (idx === -1) return p;
  const existing = p.slides[idx];
  if (!existing) return p;
  const slides = p.slides.slice();
  // A real rendered preview is per-page evidence: it
  // lifts the unit to `rendered` (spec §8.5 F).
  slides[idx] = {
    ...existing,
    previewPath,
    status: existing.status === "validated" ? "validated" : "rendered",
  };
  return { ...p, slides };
}

/** Upsert one QA entry. `passed` / `warning` / `failed`
 *  only ever arrive with evidence from a real validator
 *  (spec §8.5 G); `not_run` marks capabilities we do not
 *  have packaged. */
function withValidation(
  p: PresentationWorkflowProjection,
  check: DeliverableValidationEntry,
): PresentationWorkflowProjection {
  const idx = p.validation.findIndex((v) => v.id === check.id);
  if (idx === -1) return { ...p, validation: [...p.validation, check] };
  const existing = p.validation[idx];
  if (!existing) return p;
  const validation = p.validation.slice();
  validation[idx] = { ...existing, ...check };
  return { ...p, validation };
}

// ---------------------------------------------------------------------------
// Derived selectors (the panel's honest numbers).
// ---------------------------------------------------------------------------

/** Count slides at-or-past a status — the ONLY numbers the
 *  panel may print besides the outline's real page count. */
export function countSlidesAtLeast(
  p: PresentationWorkflowProjection,
  status: PresentationSlideUnit["status"],
): number {
  const rank: Record<PresentationSlideUnit["status"], number> = {
    queued: 0,
    content_ready: 1,
    visual_ready: 2,
    generating: 3,
    rendered: 4,
    validated: 5,
    issue: -1,
  };
  return p.slides.filter((s) => rank[s.status] >= rank[status]).length;
}

/** The REAL page count the UI may display: the approved
 *  outline length or the established unit list — NEVER the
 *  requested count (spec §8.4). Undefined = nothing real
 *  yet; the panel must not print any number. */
export function realSlideCount(
  p: PresentationWorkflowProjection,
): number | undefined {
  if (p.slides.length > 0) return p.slides.length;
  if (p.outline && p.outline.slides.length > 0) return p.outline.slides.length;
  return undefined;
}

/** True when the projection carries enough facts to show a
 *  per-page `N / M` progress. Requires real units AND a
 *  per-page fact source (at least one unit past the
 *  `generating` ceiling). */
export function hasRealPageProgress(
  p: PresentationWorkflowProjection,
): boolean {
  if (p.slides.length === 0) return false;
  return p.slides.some(
    (s) => s.status === "rendered" || s.status === "validated" || s.status === "issue",
  );
}
