import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBoardReader, withBoardWriter } from "../../../adapters/learning-store/file-event-store.js";
import { buildContentPacket } from "../../../learning/central/content/material.js";
import { compileContentProcess } from "../../../learning/central/content/process.js";
import { buildContentRecord } from "../records.js";
import { createAutomaticBoardContentSource } from "./board.js";

test("large real Board catalog does not starve one small recalled result or truncate semantic candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-large-catalog-"));
  try {
    for (let index = 0; index < 24; index++) {
      const packet = buildContentPacket({ scope: "repo:a", domain: "tool", boardSequence: index,
        records: [{ ref: `source:${index}`, runId: `run:${index}`, sequence: 0, scope: "repo:a", origin: "user_statement", text: "Original source ownership requirement." }],
        requirements: [{ id: `requirement:${index}`, requirement: `Source ownership ${"original requirement ".repeat(80)}`,
          conditions: ["Original scope"], answerRequirement: "Preserve the original requirements.", sourceRefs: [`source:${index}`] }], answers: [], materials: [] });
      assert.ok(packet.ok);
      const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "k", statement: "Confirm the source owner before searching.",
        conditions: "Original snapshot only.", citations: [{ evidenceRef: `source:${index}`, quote: "source ownership" }] }], applications: [], relations: [], preparations: [] }),
      JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
        recommendation: { kind: "undetermined", reason: "No new question.", citations: [] } }));
      assert.ok(output.ok);
      const fact = buildContentRecord(packet.value, output.value);
      const saved = await withBoardWriter(root, store => store.apply({ type: "record_reward_v2_fact", commandId: `save:${index}`, issuedAt: "2026-11-04T12:00:00Z", expectedSequence: index, fact }));
      assert.ok(saved.ok);
    }

    const input = { board: createBoardReader(root), scope: "repo:a", domain: "tool" as const, taskPurpose: "Find source ownership.", enabled: () => true,
      maximumCandidates: 24, maximumSelected: 1, maximumChars: 4000 };
    const read = await createAutomaticBoardContentSource(input).readTaskReferences(new AbortController().signal);

    assert.ok(read.ok, read.ok ? undefined : read.reason);
    assert.equal(read.value.coverage.candidates.length, 24);
    assert.ok(read.value.coverage.candidates.every(row => row.description.length > 1500));
    assert.ok(read.value.batch.records.every(row => row.text.length <= 32768));
    assert.ok(read.value.materialJson.length <= 20000);
    const usable = await createAutomaticBoardContentSource({ ...input, maximumChars: 6000 }).readTaskReferences(new AbortController().signal);
    assert.ok(usable.ok);
    assert.equal(usable.value.coverage.selectedCandidates.length, 1);
    assert.ok(usable.value.batch.answers.some(row => row.answer === "Confirm the source owner before searching."));
    assert.ok(usable.value.materialJson.length <= 22000);
    let semanticCount = 0;
    const semantic = createAutomaticBoardContentSource({ ...input, recall: { async recall(request) {
      semanticCount = request.candidates.length;
      assert.ok(request.candidates.every(row => row.description.length > 1500));
      return [];
    } } });

    assert.ok((await semantic.readTaskReferences(new AbortController().signal)).ok);
    assert.equal(semanticCount, 24);
  } finally { await rm(root, { recursive: true, force: true }); }
});
