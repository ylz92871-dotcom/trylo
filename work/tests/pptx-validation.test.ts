// Trylo Work — PPTX structure validation tests.
//
// 2026-08-29 (Work end-to-end workflow redesign spec
// §8.5 G, §16, WP-5): the minimum QA is fact-driven —
// missing file / empty file / unopenable container fail,
// a page-count mismatch against the approved outline is a
// WARNING, and the visual check without a packaged
// renderer is `not_run` — never a green pass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ConversationItem } from "../src/event-presenter.js";
import type { PresentationWorkflowProjection } from "../src/deliverables/deliverable-domain.js";
import {
  createPresentationProjection,
  reduceDeliverableEvent,
} from "../src/deliverables/presentation-workflow.js";
import { applyDeliverableItem } from "../src/deliverables/deliverable-workflow-adapter.js";
import {
  PPTX_VALIDATOR_IDS,
  evaluatePptxStructure,
  resourcesPending,
  visualQaNotRun,
  withPptxStructureFacts,
} from "../src/deliverables/pptx-validation.js";

const DID = "deliverable:r1";

/** A projection with a 3-page approved outline. */
function withOutline(): PresentationWorkflowProjection {
  let p = createPresentationProjection(DID);
  p = reduceDeliverableEvent(p, {
    type: "deliverable.outline.updated",
    deliverableId: DID,
    outline: {
      version: 1,
      status: "approved",
      slides: [
        { index: 1, title: "封面" },
        { index: 2, title: "现状" },
        { index: 3, title: "结论" },
      ],
    },
  });
  return p;
}

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

describe("evaluatePptxStructure (spec §8.5 G-1/G-2)", () => {
  it("a missing file fails", () => {
    const entry = evaluatePptxStructure(withOutline(), { fileExists: false });
    assert.equal(entry.status, "failed");
    assert.match(entry.evidence ?? "", /不存在/);
  });

  it("a zero-byte file fails", () => {
    const entry = evaluatePptxStructure(withOutline(), { fileExists: true, sizeBytes: 0 });
    assert.equal(entry.status, "failed");
  });

  it("an unopenable container fails", () => {
    const entry = evaluatePptxStructure(withOutline(), {
      fileExists: true,
      sizeBytes: 1024,
      parseable: false,
    });
    assert.equal(entry.status, "failed");
  });

  it("page count mismatch against the approved outline is a WARNING, not a failure (G-2)", () => {
    const entry = evaluatePptxStructure(withOutline(), {
      fileExists: true,
      sizeBytes: 4096,
      reportedSlideCount: 5,
    });
    assert.equal(entry.status, "warning");
    assert.match(entry.evidence ?? "", /5 页/);
    assert.match(entry.evidence ?? "", /3 页/);
  });

  it("matching page count passes with the count as evidence", () => {
    const entry = evaluatePptxStructure(withOutline(), {
      fileExists: true,
      sizeBytes: 4096,
      reportedSlideCount: 3,
    });
    assert.equal(entry.status, "passed");
    assert.equal(entry.evidence, "3 页");
  });

  it("without a reported count the pass cites the verified size", () => {
    const entry = evaluatePptxStructure(withOutline(), {
      fileExists: true,
      sizeBytes: 2048,
    });
    assert.equal(entry.status, "passed");
    assert.match(entry.evidence ?? "", /2048/);
  });

  it("no outline and no count: existence alone passes (never invents pages)", () => {
    const p = createPresentationProjection(DID);
    const entry = evaluatePptxStructure(p, { fileExists: true, sizeBytes: 512 });
    assert.equal(entry.status, "passed");
  });
});

describe("visual / resource validators stay honest (spec §16 rule 14)", () => {
  it("visual QA without a renderer is not_run, never passed", () => {
    const entry = visualQaNotRun();
    assert.equal(entry.id, PPTX_VALIDATOR_IDS.visualOverflow);
    assert.equal(entry.status, "not_run");
  });

  it("resource checks stay pending without per-page facts", () => {
    assert.equal(resourcesPending().status, "pending");
  });
});

describe("withPptxStructureFacts fold", () => {
  it("upserts the structure entry and is replay-idempotent", () => {
    const p0 = withOutline();
    const facts = { fileExists: true, sizeBytes: 4096, reportedSlideCount: 3 } as const;
    const p1 = withPptxStructureFacts(p0, facts);
    assert.equal(p1.validation.length, 1);
    const p2 = withPptxStructureFacts(p1, facts);
    // Same facts → same reference (no churn on replay).
    assert.equal(p2, p1);
  });

  it("a later fact set replaces the earlier verdict in place", () => {
    const p0 = withOutline();
    const p1 = withPptxStructureFacts(p0, { fileExists: true, sizeBytes: 4096 });
    const p2 = withPptxStructureFacts(p1, { fileExists: false });
    assert.equal(p2.validation.length, 1);
    assert.equal(p2.validation[0]?.status, "failed");
  });
});

describe("export-time QA wiring (spec §8.5 G via the adapter)", () => {
  it("a .pptx export seeds the three honest validation rows", () => {
    const pptx = item({
      kind: "artifact",
      id: "artifact:r1:D:/out/deck.pptx",
      filePath: "D:/out/deck.pptx",
    } as Partial<ConversationItem>);
    const p = applyDeliverableItem(undefined, pptx);
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    const byId = new Map(p.validation.map((v) => [v.id, v]));
    assert.equal(byId.get(PPTX_VALIDATOR_IDS.structure)?.status, "pending");
    assert.equal(byId.get(PPTX_VALIDATOR_IDS.resources)?.status, "pending");
    assert.equal(byId.get(PPTX_VALIDATOR_IDS.visualOverflow)?.status, "not_run");
  });

  it("re-exporting the same artifact does not duplicate QA rows", () => {
    const pptx = item({
      kind: "artifact",
      id: "artifact:r1:D:/out/deck.pptx",
      filePath: "D:/out/deck.pptx",
    } as Partial<ConversationItem>);
    let p = applyDeliverableItem(undefined, pptx);
    p = applyDeliverableItem(p, { ...pptx, id: "artifact:r1:again", at: 2 });
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    assert.equal(p.validation.length, 3);
  });

  it("host-supplied structure facts upgrade the pending row", () => {
    const pptx = item({
      kind: "artifact",
      id: "artifact:r1:D:/out/deck.pptx",
      filePath: "D:/out/deck.pptx",
    } as Partial<ConversationItem>);
    let p = applyDeliverableItem(undefined, pptx);
    assert.ok(p);
    if (!p) throw new Error("unreachable");
    p = withPptxStructureFacts(p, { fileExists: true, sizeBytes: 8192 });
    const row = p.validation.find((v) => v.id === PPTX_VALIDATOR_IDS.structure);
    assert.equal(row?.status, "passed");
    assert.match(row?.evidence ?? "", /8192/);
  });
});
