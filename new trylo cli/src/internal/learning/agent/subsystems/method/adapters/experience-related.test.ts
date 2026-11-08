import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import type { MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { scopesOf, snapshotOf } from "../domain/experience-state.js";
import { createExperienceRuntime } from "../orchestration/experience-runtime.js";
import { reviewExperiences } from "../orchestration/experience-review.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceStore } from "./experience-store.js";
import { createExperienceModel, type ExperienceFundingPort } from "./experience-model.js";
import { procedureFixture } from "../testing/procedure-fixture.js";

const AT = "2026-11-03T12:00:00.000Z";
const TARGET = "related-target";
const FEATURES = { format: "json", operation: "edit" };

type Material = ExperienceReviewRequest & { readonly packing?: { readonly available: Readonly<Record<string, number>>;
  readonly omitted: Readonly<Record<string, number>> } };

test("normal review supplies mature related materials to the real model adapter and synthesizes without pooling evidence", async t => {
  const parent = testScratchPath("method-related-contracts");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "board-"));
  let passed = false;

  try {
    const writer = createMethodBoardWriter(root), store = createExperienceStore(root, () => AT);
    const requests: ProviderRequest[] = [], materials: Material[] = [];
    let reservations = 0, settlements = 0;
    const funding: ExperienceFundingPort = {
      async inspect() { return { ok: true, active: true, remaining: { tokens: 24000, calls: 4, steps: 4 }, maxPromptChars: 12000 }; },
      async reserve() {
        reservations += 1;
        return { ok: true, status: "reserved" };
      },
      async settle() {
        settlements += 1;
        return { ok: true };
      },
    };
    const child: ProviderPort = { async *stream(request) {
      requests.push(request);
      const material = JSON.parse(request.messages.find(message => message.role === "user")!.content) as Material;

      materials.push(material);
      const related = material.versionId === TARGET ? material.relatedSources ?? [] : [];
      // The fixture compiler can only integrate sources actually delivered through the production transport request.
      const action = [material.method, ...related.map(item => item.compact.action)].join(" ");

      yield { type: "stream_start", providerId: "contract", model: "contract", warnings: [] };
      yield { type: "text_delta", blockId: "review", text: JSON.stringify({ decision: "promote", score: .93,
        reason: "Compile supplied same-scope practices while preserving each independent evidence set.",
        sources: [material.versionId, ...related.map(item => item.versionId)],
        compact: { when: "JSON edits", action, exceptions: "Unknown format requires ordinary inspection." },
        procedure: procedureFixture(material, action, "JSON edits", "valid payload") }) };
      yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 400, outputTokens: 100, totalTokens: 500 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };
    const provider: ProviderPort = { fork: () => child, stream: child.stream };
    const qualify = async (versionId: string, hint: string, reverse = false) => {
      const card: MethodCard = { schemaVersion: 1, hint, appliesWhen: { tools: ["read_file"] }, labels: ["containment"],
        lineage: { createdFrom: { turnId: `origin-${versionId}`, beat: 1, reason: "containment" } } };

      assert.ok((await writer.commitCard({ card, nicheId: nicheOf(card), versionId, proposalId: `proposal-${versionId}`,
        evidenceId: `origin-${versionId}`, writeId: `origin-${versionId}`, sample: "schema-edit", observedAt: AT })).ok);
      await store.append(view => ({ kind: "scope", factId: `scope-${versionId}`, versionId, sequence: view.sequence + 1,
        description: "Known JSON edits", hypothesis: { id: `range-${versionId}`, versionId, scopeId: "base",
          proposedSequence: view.sequence, predicate: { all: reverse ? [{ value: "edit", feature: "operation" }, { value: "json", feature: "format" }]
            : [{ feature: "format", value: "json" }, { feature: "operation", value: "edit" }], exclude: [] } } }));
      const runtime = createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {} });

      for (let index = 1; index <= 10; index += 1) {
        const taskId = `${versionId}-use-${index}`, context = { taskId, opportunityId: "edit", situation: "Edit a known JSON payload", features: FEATURES };

        assert.ok((await runtime.context(context, { versionId, scopeId: "base" })).some(item => item.versionId === versionId));
        const delivery = await runtime.slot(taskId);
        const receipt = delivery?.receipts.find(item => item.versionId === versionId);

        assert.ok(receipt?.binding, "a deliberate source trial must actually reach a planning request");
        const exposureId = `exposure-${taskId}`;

        assert.ok((await writer.recordUse({ writeId: exposureId, exposureId, versionId, proposalId: `proposal-${versionId}`,
          turnId: taskId, beat: 1, requestId: `request-${taskId}`, scope: "base", observedAt: AT, binding: receipt.binding })).ok);
        await runtime.decide({ versionId, scopeId: "base", action: "adopt", reason: "apply this source practice" });
        assert.ok((await writer.recordFeedback({ writeId: `feedback-${taskId}`, exposureId, versionId,
          turnId: taskId, helped: true, observedAt: AT, context })).ok);
      }

      const beforeCalls = requests.length;

      await reviewExperiences({ store, emit: () => {}, correct: async () => {}, revise: async () => {},
        model: createExperienceModel({ provider, funding, model: "contract", turnId: `review-${versionId}` }) },
      await store.load(), new AbortController().signal);
      assert.equal(requests.length, beforeCalls + 1, "one ordinary bounded model call also performs synthesis");
    };

    await qualify("related-a", "Check the declared schema before editing.");
    await qualify("related-b", "Preserve unknown fields while editing.", true);
    await qualify(TARGET, "Validate the edited payload before returning it.");
    const target = materials.find(item => item.versionId === TARGET)!;

    assert.ok((target.relatedSources?.length ?? 0) >= 1, "at least one whole compatible source must reach synthesis");
    assert.ok(target.relatedSources?.every(item => ["related-a", "related-b"].includes(item.versionId)));
    assert.equal((target.relatedSources?.length ?? 0) + (target.packing?.omitted.relatedSources ?? 0), target.packing?.available.relatedSources,
      "a packed-out source is disclosed rather than partially quoted or silently claimed");
    assert.ok(target.observations.length <= 10 && target.observations.every(item => item.versionId === TARGET),
      "packing may omit detail but related observations must not become target observations");
    assert.ok(target.experiences?.some(item => item.situation === "Edit a known JSON payload") ||
      (target.packing?.omitted.experiences ?? 0) > 0);
    assert.equal(target.evidenceSummary?.successes, 10);
    const ids = new Set(target.observations.map(item => item.observationId));

    for (const related of target.relatedSources ?? []) {
      assert.ok(related.compilationId);
      assert.equal(related.scope.scopeId, "base");
      assert.equal(related.evidence.successes, 10);
      assert.equal(related.evidence.failures, 0);
      assert.ok(related.confidence >= .95);
      assert.equal(related.evidence.observationIds.length + related.evidence.omittedObservationIds, 10);
      assert.ok(related.evidence.observationIds.every(id => !ids.has(id)), "each source retains its own independent-unit identities");
    }

    const view = await store.load();
    const aggregate = view.facts.find(item => item.kind === "review" && item.versionId === TARGET);

    assert.ok(aggregate?.kind === "review");
    assert.deepEqual(aggregate.relatedBindings, target.relatedSources?.map(item => ({ versionId: item.versionId,
      scopeId: item.scope.scopeId, compilationId: item.compilationId, snapshotId: item.qualificationSnapshotId,
      evidenceRevisions: item.qualificationEvidenceRevisions })), "the durable judgment must retain exactly the source compilations seen by the model");

    for (const versionId of ["related-a", "related-b", TARGET]) {
      assert.equal(snapshotOf(view, scopesOf(view, versionId)[0]!.hypothesis).evidence.successes, 10);
    }

    const runtime = createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {} });
    const selected = await runtime.context({ taskId: "combined-planning", opportunityId: "edit", situation: "Edit another known JSON payload", features: FEATURES });

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.stable, true);
    assert.deepEqual(new Set(selected[0]?.sourceVersionIds), new Set([TARGET, ...(target.relatedSources ?? []).map(item => item.versionId)]));
    assert.ok(target.relatedSources?.every(item => selected[0]?.compact.includes(item.compact.action)));
    assert.equal(requests.length, 3);
    assert.equal(reservations, 3);
    assert.equal(settlements, 3);
    t.diagnostic(JSON.stringify({ evidence: "scripted transport, actual production review adapter and Board",
      reviewCalls: requests.length, targetRelatedVersions: target.relatedSources?.map(item => item.versionId),
      perVersionEffectiveUses: [10, 10, 10], targetConfidence: target.confidence }));
    passed = true;
  } finally {
    if (passed) {
      assert.equal(path.dirname(root), parent);
      rmSync(root, { recursive: true, force: true });
    }
    else t.diagnostic(`Failure Board retained at ${root}`);
  }
});
