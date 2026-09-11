// Trylo Work — DeliverableWorkflowAdapter.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §8.7
// step 1 "兼容投影，零改 vendor"): turns the EXISTING
// daemon event surface into typed `DeliverableWorkflowEvent`s.
//
// Inputs today (all already on the wire, zero vendor
// changes):
//   - `deliverable_fact` items — the presenter forwards
//     `tool_call` / `tool_result` for the generator tool
//     allowlist (spec §8.3: the call carries the REAL
//     slides array and page titles);
//   - `artifact` items — a `.pptx` artifact is the export
//     fact (spec §8.3 "path / slideCount / artifact_created").
//
// The adapter never parses assistant prose, never infers
// per-page progress, and never invents counts (spec §16).

import type { ConversationItem } from "../event-presenter.js";
import type {
  DeliverableFactBody,
  DeliverableWorkflowEvent,
  PresentationBrief,
  PresentationOutline,
  PresentationOutlineSlide,
  PresentationVisualDirection,
  PresentationWorkflowProjection,
} from "./deliverable-domain.js";
import {
  detectDeliverableKindFromPath,
  detectDeliverableKindFromTool,
} from "./deliverable-registry.js";
import {
  PPTX_VALIDATOR_IDS,
  resourcesPending,
  visualQaNotRun,
} from "./pptx-validation.js";
import {
  createPresentationProjection,
  reduceDeliverableEvent,
} from "./presentation-workflow.js";

/** One deliverable per run in the pilot (spec §8.5 H
 *  revisions reuse the same deliverable identity through
 *  `revisionOf`). */
export function deliverableIdForRun(runId: string): string {
  return `deliverable:${runId}`;
}

/** The stable message / store id for the projection. */
export function deliverableMessageId(deliverableId: string): string {
  return `deliverable-projection:${deliverableId}`;
}

/** Derive the typed events one ConversationItem implies.
 *  Returns [] for items with no deliverable meaning. */
export function deliverableEventsFromItem(
  item: ConversationItem,
  existing: PresentationWorkflowProjection | undefined,
): DeliverableWorkflowEvent[] {
  const deliverableId = deliverableIdForRun(item.runId);
  if (item.kind === "deliverable_fact") {
    return eventsFromFact(item.fact, deliverableId);
  }
  if (item.kind === "artifact") {
    // A presentation artifact landing is the export fact —
    // but only for a deck-shaped path. Anything else is an
    // ordinary artifact card, not a deliverable event.
    if (detectDeliverableKindFromPath(item.filePath) !== "presentation") {
      return [];
    }
    const events: DeliverableWorkflowEvent[] = [];
    if (!existing) {
      events.push({ type: "deliverable.detected", deliverableId, kind: "presentation" });
    }
    events.push({
      type: "deliverable.exported",
      deliverableId,
      artifact: { format: "pptx", path: item.filePath },
    });
    // Spec §8.5 G: export is the QA trigger. The file-level
    // facts (exists / size / re-open) belong to the desktop
    // host and land later through `withPptxStructureFacts`;
    // until then the structure check is honest `pending`.
    // Visual QA has no packaged renderer → `not_run`, never
    // green (spec §16 rule 14).
    if (!existing?.validation.some((v) => v.id === PPTX_VALIDATOR_IDS.structure)) {
      events.push({
        type: "deliverable.validation.updated",
        deliverableId,
        check: {
          id: PPTX_VALIDATOR_IDS.structure,
          label: "文件结构与页数",
          status: "pending",
          evidence: "等待宿主文件事实",
        },
      });
    }
    if (!existing?.validation.some((v) => v.id === PPTX_VALIDATOR_IDS.resources)) {
      events.push({
        type: "deliverable.validation.updated",
        deliverableId,
        check: resourcesPending(),
      });
    }
    if (!existing?.validation.some((v) => v.id === PPTX_VALIDATOR_IDS.visualOverflow)) {
      events.push({
        type: "deliverable.validation.updated",
        deliverableId,
        check: visualQaNotRun(),
      });
    }
    return events;
  }
  return [];
}

/** Convenience fold: reduce one item into the projection
 *  (creating it when the item implies a deliverable). The
 *  desktop mapper keeps the projection on the message, so
 *  this stays pure and replay-safe. */
export function applyDeliverableItem(
  projection: PresentationWorkflowProjection | undefined,
  item: ConversationItem,
): PresentationWorkflowProjection | undefined {
  const events = deliverableEventsFromItem(item, projection);
  if (events.length === 0) return projection;
  let next = projection;
  for (const event of events) {
    if (!next) {
      next = createPresentationProjection(event.deliverableId);
    }
    next = reduceDeliverableEvent(next, event);
  }
  return next;
}

// ---------------------------------------------------------------------------
// fact parsing (defensive: the daemon shape is read but
// never trusted — every access is type-checked)
// ---------------------------------------------------------------------------

function eventsFromFact(
  fact: DeliverableFactBody,
  deliverableId: string,
): DeliverableWorkflowEvent[] {
  if (fact.type === "tool_result") {
    if (detectDeliverableKindFromTool(fact.tool) !== "presentation") return [];
    return [
      { type: "deliverable.generation.finished", deliverableId, ok: fact.ok },
    ];
  }
  // tool_call
  const kind = detectDeliverableKindFromTool(fact.tool);
  if (kind !== "presentation") return [];
  const input = fact.input ?? {};
  const events: DeliverableWorkflowEvent[] = [
    { type: "deliverable.detected", deliverableId, kind: "presentation" },
  ];

  const brief = parseBrief(input);
  if (brief) events.push({ type: "deliverable.brief.updated", deliverableId, brief });

  const style = parseVisualDirection(input);
  if (style) events.push({ type: "deliverable.style.selected", deliverableId, style });

  const slides = parseSlides(input);
  if (slides.length > 0) {
    // The generator's ACTUAL input.slides is the outline it
    // will execute (spec §8.3): version 1, approved by the
    // fact that generation starts from it. A later typed
    // checkpoint event supersedes this compatibility path.
    const outline: PresentationOutline = {
      version: 1,
      status: "approved",
      slides,
    };
    events.push({ type: "deliverable.outline.updated", deliverableId, outline });
  }

  // The call itself starts whole-deck generation. Per-page
  // numbers come ONLY from the established units (§8.5 E).
  events.push({
    type: "deliverable.generation.started",
    deliverableId,
    ...(slides.length > 0 ? { totalUnits: slides.length } : {}),
  });
  return events;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Brief fields from the generator input (spec §8.3 lists
 *  `audience / tone / …`). Only real fields are projected;
 *  missing ones stay `undefined` — the panel then shows
 *  "由 Trylo 决定" (spec §8.5 A). */
function parseBrief(
  input: Readonly<Record<string, unknown>>,
): Partial<PresentationBrief> | undefined {
  // Mutable builder view of the readonly brief contract.
  type MutableBrief = { -readonly [K in keyof PresentationBrief]?: PresentationBrief[K] };
  const brief: MutableBrief = {};
  const audience = asString(input["audience"]);
  if (audience) brief.audience = audience;
  const tone = asString(input["tone"]);
  if (tone) brief.tone = tone;
  const purpose = asString(input["purpose"]) ?? asString(input["styleBrief"]);
  if (purpose) brief.purpose = purpose;
  const language = asString(input["language"]);
  if (language) brief.language = language;
  const duration = asNumber(input["durationMinutes"]);
  if (duration) brief.durationMinutes = duration;
  const requested = asNumber(input["slideCount"]) ?? asNumber(input["requestedSlideCount"]);
  if (requested) brief.requestedSlideCount = requested;
  if (Object.keys(brief).length === 0) return undefined;
  brief.status = "ready";
  return brief;
}

/** Visual direction straight from the generator fields —
 *  no second theme system (spec §8.5 D). */
function parseVisualDirection(
  input: Readonly<Record<string, unknown>>,
): PresentationVisualDirection | undefined {
  const modeRaw = asString(input["visualMode"]);
  const mode =
    modeRaw === "work" || modeRaw === "editorial" || modeRaw === "playful" ||
    modeRaw === "premium" || modeRaw === "technical"
      ? modeRaw
      : undefined;
  const templateName = asString(input["template"]) ?? asString(input["templateName"]);
  const brand = input["brand"];
  const brandName =
    typeof brand === "string" ? asString(brand)
    : typeof brand === "object" && brand !== null
      ? asString((brand as Record<string, unknown>)["name"])
      : undefined;
  if (!mode && !templateName && !brandName) return undefined;
  return { mode, templateName, brandName, status: "selected" };
}

/** The real slides array → outline rows + unit seeds.
 *  Title falls back through `title / heading / name`;
 *  untitled pages keep an honest placeholder rather than a
 *  fabricated name. */
function parseSlides(
  input: Readonly<Record<string, unknown>>,
): PresentationOutlineSlide[] {
  const raw = input["slides"];
  if (!Array.isArray(raw)) return [];
  const slides: PresentationOutlineSlide[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) return;
    const rec = entry as Record<string, unknown>;
    const title =
      asString(rec["title"]) ?? asString(rec["heading"]) ?? asString(rec["name"])
      ?? `第 ${i + 1} 页`;
    const intent = asString(rec["intent"]) ?? asString(rec["slideType"]);
    slides.push({
      index: i + 1,
      title,
      ...(intent !== undefined ? { intent } : {}),
    });
  });
  // Bounded: a pathological payload must not explode the
  // projection (spec §14.1 "100 页不撑爆").
  return slides.slice(0, 200);
}
