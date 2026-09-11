// Trylo Work — Deliverable workflow domain tests.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §8.4,
// §8.5, §8.7, §14.1): kind detection, deterministic
// input.slides → outline/unit projection, requested vs real
// counts, the "no 4/10 fiction" ceiling, not_run visual QA,
// and replay idempotence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ConversationItem } from "../src/event-presenter.js";
import type { EventFrame } from "../src/control-plane/types.js";
import { presentTaskEvent } from "../src/event-presenter.js";
import type {
  DeliverableWorkflowEvent,
  PresentationWorkflowProjection,
} from "../src/deliverables/deliverable-domain.js";
import {
  detectDeliverableKindFromPath,
  detectDeliverableKindFromText,
  detectDeliverableKindFromTool,
  getDeliverableDefinition,
} from "../src/deliverables/deliverable-registry.js";
import {
  countSlidesAtLeast,
  createPresentationProjection,
  hasRealPageProgress,
  realSlideCount,
  reduceDeliverableEvent,
} from "../src/deliverables/presentation-workflow.js";
import {
  applyDeliverableItem,
  deliverableEventsFromItem,
  deliverableIdForRun,
} from "../src/deliverables/deliverable-workflow-adapter.js";

const DID = "deliverable:r1";

function item(over: Partial<ConversationItem> & { kind: ConversationItem["kind"] }): ConversationItem {
  return {
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
    conversationId: "c1",
    at: 1,
    ...over,
  } as ConversationItem;
}

function factItem(
  fact: { type: "tool_call"; tool: string; input?: Record<string, unknown> }
       | { type: "tool_result"; tool: string; ok: boolean },
): ConversationItem {
  return item({
    kind: "deliverable_fact",
    id: `dfact:r1:${Math.random().toString(36).slice(2)}`,
    fact,
  } as Partial<ConversationItem>);
}

function fold(
  events: DeliverableWorkflowEvent[],
  p: PresentationWorkflowProjection = createPresentationProjection(DID),
): PresentationWorkflowProjection {
  for (const event of events) p = reduceDeliverableEvent(p, event);
  return p;
}

// ---------------------------------------------------------------------------
// Registry (spec §8.7 step 1).
// ---------------------------------------------------------------------------

describe("deliverable registry (spec §8.4 / §8.9)", () => {
  it("detects the family from generator tool names", () => {
    assert.equal(detectDeliverableKindFromTool("generate_presentation"), "presentation");
    assert.equal(detectDeliverableKindFromTool("create_presentation"), "presentation");
    assert.equal(detectDeliverableKindFromTool("generate_document"), "document");
    assert.equal(detectDeliverableKindFromTool("create_spreadsheet"), "spreadsheet");
    assert.equal(detectDeliverableKindFromTool("read_file"), undefined);
    assert.equal(detectDeliverableKindFromTool(undefined), undefined);
  });

  it("detects the family from artifact extensions", () => {
    assert.equal(detectDeliverableKindFromPath("D:/out/deck.pptx"), "presentation");
    assert.equal(detectDeliverableKindFromPath("report.DOCX"), "document");
    assert.equal(detectDeliverableKindFromPath("budget.xlsx"), "spreadsheet");
    assert.equal(detectDeliverableKindFromPath("index.html"), "website");
    assert.equal(detectDeliverableKindFromPath("notes.txt"), undefined);
    assert.equal(detectDeliverableKindFromPath("noext"), undefined);
  });

  it("keyword pass is a last-resort signal only", () => {
    assert.equal(detectDeliverableKindFromText("帮我做一份 PPT"), "presentation");
    assert.equal(detectDeliverableKindFromText("写一份调研报告"), "research");
    assert.equal(detectDeliverableKindFromText("随便聊聊"), undefined);
  });

  it("PPT definition carries the 8-milestone axis + outline checkpoint", () => {
    const def = getDeliverableDefinition("presentation");
    assert.equal(def.kind, "presentation");
    assert.equal(def.unitType, "slide");
    assert.deepEqual(
      def.milestones.map((m) => m.id),
      ["brief", "sources", "outline", "visual", "generate", "preview", "qa", "export"],
    );
    assert.equal(def.checkpoints[0]?.id, "outline_review");
    assert.equal(def.checkpoints[0]?.afterMilestone, "outline");
    const visual = def.validators.find((v) => v.kind === "visual");
    assert.ok(visual, "the PPT axis declares a visual validator");
  });

  it("unknown kinds fall back to the generic axis", () => {
    const def = getDeliverableDefinition("whatever");
    assert.equal(def.kind, "generic");
    assert.ok(def.milestones.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Reducer honesty invariants (spec §8.5, §16).
// ---------------------------------------------------------------------------

describe("presentation reducer: honest progress (spec §8.5 E / §16)", () => {
  const outlineEvent = (n: number, version = 1): DeliverableWorkflowEvent => ({
    type: "deliverable.outline.updated",
    deliverableId: DID,
    outline: {
      version,
      status: "approved",
      slides: Array.from({ length: n }, (_, i) => ({ index: i + 1, title: `页 ${i + 1}` })),
    },
  });

  it("requestedSlideCount NEVER becomes the realized page count", () => {
    const p = fold([
      {
        type: "deliverable.brief.updated",
        deliverableId: DID,
        brief: { requestedSlideCount: 10, status: "ready" },
      },
      { type: "deliverable.generation.started", deliverableId: DID },
    ]);
    assert.equal(realSlideCount(p), undefined, "no real units → no printable count");
    assert.equal(p.slides.length, 0, "a requested count never spawns unit rows");
    assert.equal(p.brief.requestedSlideCount, 10);
  });

  it("whole-deck generation without per-page callbacks never prints 4/10", () => {
    const p = fold([
      outlineEvent(10),
      { type: "deliverable.generation.started", deliverableId: DID, totalUnits: 10 },
      { type: "deliverable.generation.finished", deliverableId: DID, ok: true },
    ]);
    assert.equal(p.generating, false);
    assert.equal(p.slides.length, 10);
    assert.ok(p.slides.every((s) => s.status === "generating"));
    assert.equal(hasRealPageProgress(p), false, "no per-page fact → no N/M progress");
    assert.equal(countSlidesAtLeast(p, "rendered"), 0);
  });

  it("a per-page fact is the only way past the generating ceiling", () => {
    const p = fold([
      outlineEvent(3),
      { type: "deliverable.generation.started", deliverableId: DID, totalUnits: 3 },
      {
        type: "deliverable.unit.updated",
        deliverableId: DID,
        unit: { index: 1, title: "页 1", status: "rendered" },
      },
    ]);
    assert.equal(hasRealPageProgress(p), true);
    assert.equal(countSlidesAtLeast(p, "rendered"), 1);
  });

  it("a stray unit for an unplanned index never inflates the deck", () => {
    const p = fold([
      outlineEvent(3),
      {
        type: "deliverable.unit.updated",
        deliverableId: DID,
        unit: { index: 99, title: "ghost", status: "rendered" },
      },
    ]);
    assert.equal(p.slides.length, 3);
  });

  it("generation failure marks generating units as issue", () => {
    const p = fold([
      outlineEvent(2),
      { type: "deliverable.generation.started", deliverableId: DID },
      { type: "deliverable.generation.finished", deliverableId: DID, ok: false },
    ]);
    assert.ok(p.slides.every((s) => s.status === "issue"));
    assert.equal(p.generating, false);
  });

  it("a visual check without a renderer is not_run, never green", () => {
    const p = fold([
      {
        type: "deliverable.validation.updated",
        deliverableId: DID,
        check: { id: "visual_overflow", label: "文字溢出与版式", status: "not_run" },
      },
    ]);
    assert.equal(p.validation[0]?.status, "not_run");
    assert.notEqual(p.validation[0]?.status, "passed");
  });

  it("validation upserts by id; passed needs evidence", () => {
    const p = fold([
      {
        type: "deliverable.validation.updated",
        deliverableId: DID,
        check: { id: "structure", label: "文件结构与页数", status: "running" },
      },
      {
        type: "deliverable.validation.updated",
        deliverableId: DID,
        check: { id: "structure", label: "文件结构与页数", status: "passed", evidence: "10/10 slides parsed" },
      },
    ]);
    assert.equal(p.validation.length, 1);
    assert.equal(p.validation[0]?.status, "passed");
    assert.equal(p.validation[0]?.evidence, "10/10 slides parsed");
  });

  it("a newer outline supersedes in place — no stacked cards", () => {
    const p = fold([outlineEvent(10, 1), outlineEvent(8, 2)]);
    assert.equal(p.outline?.version, 2);
    assert.equal(p.outline?.slides.length, 8);
    assert.equal(p.slides.length, 8, "units rebuild from the new outline");
    assert.equal(p.outlineVersion, 2);
  });

  it("a late older outline never regresses the deck", () => {
    const p = fold([outlineEvent(8, 2), outlineEvent(10, 1)]);
    assert.equal(p.outline?.version, 2);
    assert.equal(p.slides.length, 8);
  });

  it("checkpoint puts a draft outline into awaiting_review", () => {
    const p = fold([
      {
        type: "deliverable.outline.updated",
        deliverableId: DID,
        outline: { version: 1, status: "draft", slides: [{ index: 1, title: "a" }] },
      },
      { type: "deliverable.checkpoint.requested", deliverableId: DID, checkpointId: "outline_review" },
    ]);
    assert.equal(p.outline?.status, "awaiting_review");
  });

  it("exports dedupe on format+path", () => {
    const artifact = { format: "pptx" as const, path: "D:/out/deck.pptx" };
    const p = fold([
      { type: "deliverable.exported", deliverableId: DID, artifact },
      { type: "deliverable.exported", deliverableId: DID, artifact },
    ]);
    assert.equal(p.exports.length, 1);
  });

  it("preview lifts the unit to rendered", () => {
    const p = fold([
      outlineEvent(2),
      { type: "deliverable.preview.ready", deliverableId: DID, index: 1, previewPath: "p/1.png" },
    ]);
    assert.equal(p.slides[0]?.status, "rendered");
    assert.equal(p.slides[0]?.previewPath, "p/1.png");
    assert.equal(p.slides[1]?.status, "queued");
  });

  it("replaying the same event sequence converges (idempotent)", () => {
    const events: DeliverableWorkflowEvent[] = [
      {
        type: "deliverable.brief.updated",
        deliverableId: DID,
        brief: { audience: "管理层", requestedSlideCount: 10, status: "ready" },
      },
      outlineEvent(10),
      { type: "deliverable.generation.started", deliverableId: DID, totalUnits: 10 },
      { type: "deliverable.exported", deliverableId: DID, artifact: { format: "pptx", path: "D:/x.pptx" } },
      { type: "deliverable.generation.finished", deliverableId: DID, ok: true },
    ];
    const once = fold(events);
    const twice = fold([...events, ...events]);
    assert.deepEqual(twice, once);
  });

  it("events for another deliverable are ignored", () => {
    const p = fold([
      {
        type: "deliverable.brief.updated",
        deliverableId: "deliverable:other",
        brief: { status: "ready" },
      },
    ]);
    assert.equal(p.brief.status, "collecting");
  });
});

// ---------------------------------------------------------------------------
// Adapter: compatibility projection, zero vendor changes (spec §8.7 step 1).
// ---------------------------------------------------------------------------

describe("deliverable adapter (spec §8.7)", () => {
  it("a generator tool_call projects brief + outline + generation start", () => {
    const call = factItem({
      type: "tool_call",
      tool: "generate_presentation",
      input: {
        audience: "管理层",
        tone: "专业",
        durationMinutes: 10,
        slideCount: 12,
        visualMode: "premium",
        template: "Corporate Blue",
        slides: [
          { title: "封面" },
          { heading: "目录" },
          { name: "背景" },
          {},
        ],
      },
    });
    const p = applyDeliverableItem(undefined, call);
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    assert.equal(p.deliverableId, deliverableIdForRun("r1"));
    assert.equal(p.brief.audience, "管理层");
    assert.equal(p.brief.tone, "专业");
    assert.equal(p.brief.durationMinutes, 10);
    assert.equal(p.brief.requestedSlideCount, 12);
    assert.equal(p.brief.status, "ready");
    assert.equal(p.visualDirection?.mode, "premium");
    assert.equal(p.visualDirection?.templateName, "Corporate Blue");
    assert.equal(p.outline?.version, 1);
    assert.equal(p.outline?.status, "approved");
    assert.deepEqual(
      p.outline?.slides.map((s) => s.title),
      ["封面", "目录", "背景", "第 4 页"],
      "title falls back heading → name → honest placeholder",
    );
    assert.equal(p.generating, true);
    assert.equal(p.slides.length, 4);
    assert.ok(p.slides.every((s) => s.status === "generating"));
    assert.equal(realSlideCount(p), 4, "real count = input.slides length, NOT slideCount");
  });

  it("a tool_call without slides never invents units", () => {
    const p = applyDeliverableItem(undefined, factItem({
      type: "tool_call",
      tool: "generate_presentation",
      input: { slideCount: 8 },
    }));
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    assert.equal(p.slides.length, 0);
    assert.equal(realSlideCount(p), undefined);
    assert.equal(p.brief.requestedSlideCount, 8);
    assert.equal(p.generating, true);
  });

  it("a tool_result finishes generation", () => {
    let p = applyDeliverableItem(undefined, factItem({
      type: "tool_call",
      tool: "generate_presentation",
      input: { slides: [{ title: "a" }] },
    }));
    p = applyDeliverableItem(p, factItem({ type: "tool_result", tool: "generate_presentation", ok: true }));
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    assert.equal(p.generating, false);
  });

  it("a .pptx artifact is the export fact; other artifacts are not", () => {
    const pptx = item({ kind: "artifact", id: "artifact:r1:D:/out/deck.pptx", filePath: "D:/out/deck.pptx" } as Partial<ConversationItem>);
    const p = applyDeliverableItem(undefined, pptx);
    assert.ok(p, "a deck artifact alone creates the projection");
    if (!p) throw new Error("unreachable");
    assert.deepEqual(p.exports, [{ format: "pptx", path: "D:/out/deck.pptx" }]);

    const txt = item({ kind: "artifact", id: "artifact:r1:D:/out/notes.txt", filePath: "D:/out/notes.txt" } as Partial<ConversationItem>);
    assert.equal(deliverableEventsFromItem(txt, undefined).length, 0);
  });

  it("unrelated items produce no deliverable events", () => {
    const thinking = item({ kind: "thinking", id: "thinking:r1", text: "hmm", phaseId: undefined } as Partial<ConversationItem>);
    assert.equal(deliverableEventsFromItem(thinking, undefined).length, 0);
    assert.equal(applyDeliverableItem(undefined, thinking), undefined);
  });

  it("non-generator tool facts stay out of the channel", () => {
    const p = applyDeliverableItem(undefined, factItem({
      type: "tool_call",
      tool: "read_file",
      input: { path: "x.md" },
    }));
    assert.equal(p, undefined);
  });

  it("caps a pathological slides array (spec §14.1: 100 页不撑爆)", () => {
    const p = applyDeliverableItem(undefined, factItem({
      type: "tool_call",
      tool: "generate_presentation",
      input: { slides: Array.from({ length: 500 }, (_, i) => ({ title: `s${i}` })) },
    }));
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    assert.ok(p.slides.length <= 200);
  });

  it("the full pipeline is replay-idempotent item by item", () => {
    const items = [
      factItem({ type: "tool_call", tool: "generate_presentation", input: { slides: [{ title: "a" }, { title: "b" }] } }),
      item({ kind: "artifact", id: "artifact:r1:D:/o.pptx", filePath: "D:/o.pptx" } as Partial<ConversationItem>),
      factItem({ type: "tool_result", tool: "generate_presentation", ok: true }),
    ];
    let once: PresentationWorkflowProjection | undefined;
    for (const it of items) once = applyDeliverableItem(once, it);
    let twice: PresentationWorkflowProjection | undefined;
    for (const it of [...items, ...items]) twice = applyDeliverableItem(twice, it);
    // tool_call replays re-derive the same v1 outline (same-version
    // refresh) — the projection must converge to an equal shape.
    assert.deepEqual(twice, once);
  });
});

// ---------------------------------------------------------------------------
// Presenter gating (spec §8.7: only allowlisted tools emit facts).
// ---------------------------------------------------------------------------

describe("presenter deliverable_fact gating (spec §8.3 / §8.7)", () => {
  function taskEvent(inner: Record<string, unknown>): EventFrame {
    return { type: "event", event: "task.event", payload: inner };
  }

  it("forwards a generate_presentation tool_call as a typed fact", () => {
    const out = presentTaskEvent(
      taskEvent({
        type: "tool_call",
        tool: "generate_presentation",
        input: { slides: [{ title: "封面" }] },
        seq: 7,
      }),
      "t1",
      "r1",
    );
    assert.ok(out);
    if (!out) throw new Error("unreachable");
    assert.equal(out.kind, "deliverable_fact");
    if (out.kind === "deliverable_fact") {
      assert.equal(out.fact.type, "tool_call");
      if (out.fact.type === "tool_call") {
        assert.equal(out.fact.tool, "generate_presentation");
        assert.ok(Array.isArray(out.fact.input?.["slides"]));
      }
    }
  });

  it("reads the nested-payload shape too (older builds)", () => {
    const out = presentTaskEvent(
      taskEvent({
        type: "tool_call",
        payload: { tool: "create_presentation", input: { slideCount: 5 } },
        seq: 8,
      }),
      "t1",
      "r1",
    );
    assert.ok(out);
    if (!out) throw new Error("unreachable");
    assert.equal(out.kind, "deliverable_fact");
  });

  it("never emits facts for non-generator tools", () => {
    const out = presentTaskEvent(
      taskEvent({ type: "tool_call", tool: "read_file", input: { path: "a" }, seq: 9 }),
      "t1",
      "r1",
    );
    assert.equal(out, null);
  });

  it("maps tool_result / tool_error to ok facts", () => {
    const ok = presentTaskEvent(
      taskEvent({ type: "tool_result", tool: "generate_presentation", seq: 10 }),
      "t1",
      "r1",
    );
    assert.ok(ok && ok.kind === "deliverable_fact");
    if (ok && ok.kind === "deliverable_fact") {
      assert.equal(ok.fact.type, "tool_result");
      if (ok.fact.type === "tool_result") assert.equal(ok.fact.ok, true);
    }
    const err = presentTaskEvent(
      taskEvent({ type: "tool_error", tool: "generate_presentation", seq: 11 }),
      "t1",
      "r1",
    );
    assert.ok(err && err.kind === "deliverable_fact");
    if (err && err.kind === "deliverable_fact") {
      assert.equal(err.fact.type, "tool_result");
      if (err.fact.type === "tool_result") assert.equal(err.fact.ok, false);
    }
  });
});
