import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceStore } from "./experience-store.js";
import { createExperienceRuntime, type ExperienceRuntime, type ExperienceStore } from "../orchestration/experience-runtime.js";
import { reviewExperiences } from "../orchestration/experience-review.js";
import { snapshotOf, scopesOf, matureReview } from "../domain/experience-state.js";
import { evidenceOf } from "../domain/inference-observations.js";
import type { MethodCard } from "../domain/contracts.js";
import type { ExperienceContext, ExperienceReview } from "../experience-port.js";
import type { FeedbackInput, MethodArchivePort } from "../port.js";
import { nicheOf } from "../domain/niche.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { normalizeBoardState } from "../../../../control/state.js";
import { procedureFixture } from "../testing/procedure-fixture.js";
import { createMethodFocusedLearning } from "./focused-learning.js";
import { createExperienceFunding } from "./experience-funding.js";
import { pendingExperienceReview } from "../orchestration/experience-review.js";
import { emptyUsage, type ProviderPort } from "../../../../../ports/provider.js";

const AT = "2026-11-03T08:00:00.000Z";
const VERSION = "experience-v1";
const ORIGINAL = "Read the complete structured document and verify its declared schema before editing any payload.";
const CARD: MethodCard = { schemaVersion: 1, hint: ORIGINAL, appliesWhen: { tools: ["read_file"] },
  labels: ["containment"], family: "containment",
  lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" } } };
const COMPACT = { when: "JSON document", action: "Validate schema, then edit.", exceptions: "Unknown schema: inspect first." };

type Setup = { root: string; store: ExperienceStore; writer: MethodArchivePort; runtime: ExperienceRuntime };

async function usingBoard(run: (setup: Setup) => Promise<void>) {
  const parent = testScratchPath("method-experience-contracts");

  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "trylo-method-experience-contract-"));

  try {
    const writer = createMethodBoardWriter(root);
    await commit(writer, VERSION);
    const store = createExperienceStore(root, () => AT);
    await register(store, VERSION);
    await run({ root, writer, store, runtime: runtimeFor(store) });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("trylo-method-experience-contract-"));
    rmSync(root, { recursive: true, force: true });
  }
}

function context(taskId: string, format = "json"): ExperienceContext {
  return { taskId, opportunityId: "schema-edit", situation: "Edit a document with a declared schema", features: { format } };
}

function runtimeFor(store: ExperienceStore, review?: ExperienceReview) {
  return createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {},
    ...(review === undefined ? {} : { model: { review: async () => review } }) });
}

async function commit(writer: MethodArchivePort, versionId: string, hint = CARD.hint) {
  const card = { ...CARD, hint };
  const written = await writer.commitCard({ card, nicheId: nicheOf(card), versionId,
    proposalId: `proposal-${versionId}`, evidenceId: `evidence-${versionId}`, writeId: `seed-${versionId}`,
    sample: "structured_document:unknown_schema", observedAt: AT });
  assert.ok(written.ok);
}

async function register(store: ExperienceStore, versionId: string) {
  await store.append(source => ({ kind: "scope", factId: `scope-${versionId}`, versionId, sequence: source.sequence + 1,
    description: "JSON documents with declared schemas", hypothesis: { id: `range-${versionId}`, versionId, scopeId: "base",
      proposedSequence: source.sequence, predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } }));
}

async function use(setup: Setup, taskId: string, helped?: boolean, options: { adopt?: boolean; exposureSuffix?: string; versionId?: string } = {}) {
  const versionId = options.versionId ?? VERSION;
  const selected = await setup.runtime.context(context(taskId));

  assert.ok(selected.some(item => item.versionId === versionId));
  const delivery = await setup.runtime.slot(taskId);

  assert.ok(delivery);
  assert.ok(delivery?.receipts.some(item => item.versionId === versionId), "the normal slot must carry the chosen source identity");
  const exposureId = `exposure-${taskId}${options.exposureSuffix ?? ""}`;
  const fielded = await setup.writer.recordUse({ writeId: exposureId, exposureId, versionId,
    proposalId: `proposal-${versionId}`, turnId: taskId, beat: 1, requestId: `request-${exposureId}`, scope: "base", observedAt: AT,
    ...(delivery.receipts.find(item => item.versionId === versionId)?.binding === undefined ? {} : {
      binding: delivery.receipts.find(item => item.versionId === versionId)!.binding! }) });

  assert.ok(fielded.ok);

  if (options.adopt !== false) await setup.runtime.decide({ versionId, scopeId: "base", action: "adopt", reason: "use schema-first plan" });

  const feedback: FeedbackInput = { writeId: `feedback-${exposureId}`, exposureId, versionId,
    turnId: taskId, helped: helped ?? true, context: context(taskId), observedAt: AT };

  if (helped !== undefined) assert.ok((await setup.writer.recordFeedback(feedback)).ok);

  return feedback;
}

async function accumulate(setup: Setup, count: number, prefix = "use", helped = true, versionId = VERSION) {
  for (let index = 1; index <= count; index += 1) await use(setup, `${prefix}-${index}`, helped, { versionId });
}

async function appendReview(store: ExperienceStore, review: ExperienceReview, versionId = VERSION) {
  return store.append(source => {
    const scope = scopesOf(source, versionId)[0]!.hypothesis;
    const snapshot = snapshotOf(source, scope);
    const relatedBindings = review.sources.filter(id => id !== versionId).flatMap(id => {
      const related = scopesOf(source, id).find(item => item.hypothesis.scopeId === scope.scopeId)?.hypothesis;
      const mature = related === undefined ? undefined : matureReview(source, related);
      return mature === undefined ? [] : [{ versionId: id, scopeId: scope.scopeId, compilationId: mature.factId,
        snapshotId: mature.snapshotId, evidenceRevisions: mature.evidenceRevisions }];
    });

    return { kind: "review", factId: `review-${snapshot.snapshotId}`, versionId, sequence: source.sequence + 1,
      scopeId: scope.scopeId, snapshotId: snapshot.snapshotId, evidenceRevisions: snapshot.revisions, review,
      ...(relatedBindings.length === 0 ? {} : { relatedBindings }) };
  });
}

function promotion(score = .9): ExperienceReview {
  return { decision: "promote", score, reason: "prospective uses support this scope", compact: COMPACT, sources: [VERSION] };
}

for (const legacy of [false, true]) test(`PA focused method consumes its original ${legacy ? "legacy" : "canonical"} grant, records a real review and yields for future evidence`, async () => usingBoard(async setup => {
  await accumulate(setup, 10);
  const view = await setup.store.load();
  const request = pendingExperienceReview({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {} },
    view, { versionId: VERSION, scopeId: "base" });
  assert.ok(request);
  const purse = createExperienceFunding({ boardRoot: setup.root, workspaceId: "legacy-hash", ...(legacy ? {} : { centralScope: "D:/workspace" }),
    turnId: "learning-source", now: () => AT, request, enabled: () => true });

  assert.ok((await purse.inspect()).ok);
  const before = await createBoardReader(setup.root).load();
  assert.ok(before.ok);
  const issue = before.state.learningIssues![0]!;
  let calls = 0;
  const child: ProviderPort = { async *stream() {
    calls++;
    yield { type: "stream_start", providerId: "scripted", model: "scripted", warnings: [] };
    yield { type: "text_delta", blockId: "review", text: JSON.stringify({ decision: "defer", score: .6,
      reason: "Need more varied task evidence before compilation", sources: [VERSION] }) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const owner = createMethodFocusedLearning({ boardRoot: setup.root, scope: "D:/workspace", workspaceId: "legacy-hash", turnId: "PA",
    provider: { stream: child.stream, fork: () => child }, model: "scripted", now: () => AT, emit: () => {} });
  const focused = await owner.focus({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: "Review the qualified schema method", sourceRefs: [request.snapshotId] }, new AbortController().signal);

  assert.ok(focused.ok, focused.ok ? "" : focused.reason);
  assert.equal(focused.status, "completed");
  assert.equal(calls, 1);
  const after = await createBoardReader(setup.root).load();
  assert.ok(after.ok);
  assert.equal(after.state.centralLearningGrants!.length, 1);
  assert.equal(after.state.centralLearningGrants![0]!.reservations.length, 1);
  assert.equal(after.state.centralLearningGrants![0]!.status, "open");
  assert.equal(after.state.jobs[0]!.state, "queued");
  assert.ok((await setup.store.load()).facts.some(fact => fact.kind === "review" && fact.review.decision === "defer"));
  const resumed = await owner.resume(new AbortController().signal);
  assert.ok(resumed.ok);
  assert.equal(resumed.status, "idle");
  assert.equal(calls, 1, "unchanged evidence cannot spend another model call");
}));

test("PA method marks a worker attempt without claiming success when its qualified review cannot enter the model", async () => usingBoard(async setup => {
  await accumulate(setup, 10);
  const request = pendingExperienceReview({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {} },
    await setup.store.load(), { versionId: VERSION, scopeId: "base" });
  assert.ok(request);
  assert.ok((await createExperienceFunding({ boardRoot: setup.root, workspaceId: "legacy-hash", centralScope: "D:/workspace",
    turnId: "source", now: () => AT, request, enabled: () => true }).inspect()).ok);
  let calls = 0;
  const options = { boardRoot: setup.root, workspaceId: "legacy-hash", scope: "D:/workspace", turnId: "PA",
    provider: { async *stream() {
      calls++;
      throw new Error("An unisolated provider must never be called");
    } },
    model: "unforkable", now: () => AT, emit: () => {} };
  const preflight = await createMethodFocusedLearning({ ...options, claimReview: () => false }).resume(new AbortController().signal);

  assert.ok(preflight.ok);
  assert.equal(preflight.status, "idle");
  assert.equal(preflight.workAttempted, undefined);
  const result = await createMethodFocusedLearning(options).resume(new AbortController().signal);

  assert.ok(result.ok);
  assert.equal(result.status, "idle");
  assert.equal(result.workAttempted, true, "Invoking the method worker consumes this PA dispatch even without a review fact");
  assert.equal(calls, 0);
  assert.equal((await setup.store.load()).facts.some(fact => fact.kind === "review"), false);
  const after = await createBoardReader(setup.root).load();
  assert.ok(after.ok);
  assert.equal(after.state.centralLearningGrants![0]!.reservations.length, 0);
  assert.equal(after.state.centralLearningGrants![0]!.status, "open");
}));

for (const cancelled of [false, true]) test(`PA method ${cancelled ? "cancellation" : "invalid response"} preserves its lifetime allowance for new evidence without resampling the same snapshot`, async () => usingBoard(async setup => {
  await accumulate(setup, 10);
  const view = await setup.store.load();
  const request = pendingExperienceReview({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {} },
    view, { versionId: VERSION, scopeId: "base" });
  assert.ok(request);
  const purse = createExperienceFunding({ boardRoot: setup.root, workspaceId: "legacy-hash", centralScope: "D:/workspace",
    turnId: "learning-source", now: () => AT, request, enabled: () => true });

  assert.ok((await purse.inspect()).ok);
  const before = await createBoardReader(setup.root).load();
  assert.ok(before.ok);
  const issue = before.state.learningIssues![0]!;
  let calls = 0;
  const abort = new AbortController();
  const child: ProviderPort = { async *stream() {
    calls++;
    yield { type: "stream_start", providerId: "scripted", model: "scripted", warnings: [] };
    if (cancelled) {
      abort.abort();
      return;
    }
    yield { type: "text_delta", blockId: "review", text: "invalid JSON" };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const owner = createMethodFocusedLearning({ boardRoot: setup.root, scope: "D:/workspace", workspaceId: "legacy-hash", turnId: "PA",
    provider: { stream: child.stream, fork: () => child }, model: "scripted", now: () => AT, emit: () => {} });

  await owner.focus({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: "Review the qualified schema method", sourceRefs: [request.snapshotId] }, abort.signal);
  const after = await createBoardReader(setup.root).load();
  assert.ok(after.ok);
  assert.equal(after.state.centralLearningGrants![0]!.status, "open", "A failed review consumes one request, not the remaining lifetime purse");
  assert.equal(after.state.jobs[0]!.state, "queued");
  assert.equal(after.state.centralLearningGrants![0]!.reservations.length, 1);
  const resumed = await owner.resume(new AbortController().signal);
  assert.ok(resumed.ok);
  assert.equal(resumed.status, "waiting_dependency");
  assert.equal(calls, 1, "an unchanged snapshot's reservation prevents another draw");
  await accumulate(setup, 7, "fresh-evidence");
  await owner.resume(new AbortController().signal);
  assert.equal(calls, 2, "genuinely new evidence can consume another call from the same purse");
  const final = await createBoardReader(setup.root).load();
  assert.ok(final.ok);
  assert.equal(final.state.centralLearningGrants!.length, 1);
  assert.equal(final.state.centralLearningGrants![0]!.reservations.length, 2);
}));

test("production Board enforces all four A/M combinations and retrieves only compact mature content", async () => {
  for (const algorithmHigh of [false, true]) for (const modelHigh of [false, true]) {
    await usingBoard(async setup => {
      if (algorithmHigh) await accumulate(setup, 10);

      const attempt = appendReview(setup.store, promotion(modelHigh ? .9 : .4));

      if (!algorithmHigh || !modelHigh) await assert.rejects(attempt, /invalid_feedback/);
      else await attempt;

      const restarted = runtimeFor(createExperienceStore(setup.root, () => AT));
      const selected = await restarted.context(context("normal-followup"));

      assert.equal(selected[0]?.stable, algorithmHigh && modelHigh);
      const slot = await restarted.slot("normal-followup");

      assert.ok(slot);

      if (algorithmHigh && modelHigh) {
        assert.ok(slot.message.content.includes(COMPACT.action));
        assert.equal(slot.message.content.includes(ORIGINAL), false, "compact must replace the original body in the normal request");
        await assert.rejects(restarted.decide({ versionId: VERSION, scopeId: "base", action: "adopt", reason: "skip fresh method comparison" }), /invalid_feedback/);
        assert.ok((await setup.writer.recordUse({ writeId: "normal-followup-send", exposureId: "normal-followup-send",
          versionId: VERSION, proposalId: `proposal-${VERSION}`, turnId: "normal-followup", beat: 1,
          requestId: "normal-followup-request", scope: "base", observedAt: AT,
          ...(slot.receipts[0]?.binding === undefined ? {} : { binding: slot.receipts[0].binding }) })).ok);
        await restarted.decide({ versionId: VERSION, scopeId: "base", action: "adopt", reason: "skip fresh method comparison" });
        const persisted = await setup.store.load();

        assert.ok(persisted.facts.some(item => item.kind === "decision" && item.context.taskId === "normal-followup" && item.decision.action === "adopt"));
      }

      assert.deepEqual(await restarted.context(context("outside", "csv")), []);
    });
  }
});

test("production feedback distinguishes display, missing, duplicate opportunity and explicit revision after restart", async () => {
  await usingBoard(async setup => {
    await use(setup, "missing");
    await use(setup, "displayed", true, { adopt: false });
    const feedback = await use(setup, "adopted", true);
    const duplicate = await createMethodBoardWriter(setup.root).recordFeedback(feedback);

    assert.ok(duplicate.ok && duplicate.duplicate, "enriched feedback must replay identically, without losing its observation");
    await use(setup, "adopted", true, { exposureSuffix: "-second" });
    let view = await setup.store.load();
    let evidence = evidenceOf(view.observations, { versionId: VERSION, scopeId: "base" });

    assert.equal(evidence.successes, 1);
    assert.equal(evidence.notAdopted, 1);
    assert.equal(view.observations.filter(item => item.taskId === "missing").length, 0);
    const observation = evidence.observations[0]!;
    const corrected = await setup.writer.recordFeedback({ ...feedback, writeId: "authoritative-correction", helped: false,
      observation: { ...observation, revision: 1, outcome: "unhelpful" } });

    assert.ok(corrected.ok);
    view = await createExperienceStore(setup.root, () => AT).load();
    evidence = evidenceOf(view.observations, { versionId: VERSION, scopeId: "base" });
    assert.equal(evidence.successes, 0);
    assert.equal(evidence.failures, 1);
    const compacted = await withBoardWriter(setup.root, async store => { const loaded = await store.load();
      assert.ok(loaded.ok);
    return store.compact(loaded.generation); });

    assert.ok(compacted.ok);
    assert.deepEqual(evidenceOf((await setup.store.load()).observations, { versionId: VERSION, scopeId: "base" }), evidence);
  });
});

test("model defer is persisted without a failure and the same evidence is never asked twice", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    let calls = 0;
    const options = { store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {}, model: { review: async (request: import("../experience-port.js").ExperienceReviewRequest) => {
      calls += 1;

      if (calls === 2) {
        assert.equal(request.previousAssessment?.decision, "defer");
        assert.ok(request.previousAssessment.reason.startsWith("need varied uses") && request.previousAssessment.reason.length <= 240);
        assert.equal(request.previousAssessment.excerpted, true);
      }

      return { decision: "defer" as const, score: .3, reason: "need varied uses: " + "证".repeat(1100), sources: [VERSION] };
    } } };

    await reviewExperiences(options, await setup.store.load(), new AbortController().signal);
    await reviewExperiences(options, await setup.store.load(), new AbortController().signal);
    assert.equal(calls, 1);
    const view = await setup.store.load();

    assert.equal(evidenceOf(view.observations, { versionId: VERSION }).successes, 10);
    assert.equal((await runtimeFor(setup.store).context(context("after-defer")))[0]?.stable, false);
    await accumulate(setup, 7, "new-source");
    await reviewExperiences(options, await setup.store.load(), new AbortController().signal);
    assert.equal(calls, 2, "new source information permits reconsideration while preserving prior semantic limitations");
    const expanded = JSON.parse(await runtimeFor(setup.store).expand(VERSION));

    assert.equal(expanded.compilation, undefined);
    assert.equal(expanded.latestAssessment.decision, "defer");
    assert.ok(expanded.latestAssessment.reason.length <= 1000 && expanded.latestAssessment.excerpted);
  });
});

test("all custom model ports must return a source-linked procedure for a new compilation", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    const options = { store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {} };

    await assert.rejects(reviewExperiences({ ...options, model: { review: async () => promotion() } },
      await setup.store.load(), new AbortController().signal), /method_review_procedure_required/);
    assert.equal((await setup.store.load()).facts.filter(fact => fact.kind === "review").length, 0);
    await reviewExperiences({ ...options, model: { review: async request => ({ ...promotion(),
      procedure: procedureFixture(request, COMPACT.action, COMPACT.when, "schema confirmed") }) } },
      await setup.store.load(), new AbortController().signal);
    assert.ok(matureReview(await setup.store.load(), scopesOf(await setup.store.load(), VERSION)[0]!.hypothesis));
  });
});

test("task-local block survives restart of that task but does not disable a later independent task", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    await setup.runtime.context(context("blocked-task"));
    await setup.runtime.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "schema unavailable",
      step: "validate schema", facts: "schema registry cannot be reached" });
    assert.deepEqual(await setup.runtime.context(context("blocked-task")), []);
    assert.deepEqual(await runtimeFor(setup.store).context(context("blocked-task")), []);
    const slot = await setup.runtime.slot("blocked-task");

    assert.equal(slot?.message.content.includes(COMPACT.action), false);
    assert.equal((await setup.runtime.context(context("independent-task")))[0]?.stable, true,
      "a task-local unknown blockage must not become a global failure or disable later tasks");
    assert.equal(evidenceOf((await setup.store.load()).observations, { versionId: VERSION }).failures, 0);
  });
});

test("expression repair retains maturity, while a behavior revision needs its own future evidence", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    await setup.runtime.context(context("ambiguous"));
    await setup.runtime.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "wording omitted registry fallback", step: "validate schema" });
    const expression = { ...promotion(), decision: "expression" as const, compact: { ...COMPACT, exceptions: "Use local schema when registry is unavailable." } };

    await reviewExperiences({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {}, model: { review: async request => ({
      ...expression, procedure: procedureFixture(request, COMPACT.action, COMPACT.when, "schema confirmed") }) } },
      await setup.store.load(), new AbortController().signal);
    const repaired = runtimeFor(setup.store);
    const choices = await repaired.context(context("after-expression"));

    assert.equal(choices[0]?.stable, true);
    assert.ok(choices[0]?.compact.includes("Use local schema"));
    await repaired.context(context("changed-action"));
    await repaired.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "actual algorithm incompatible", step: "validate schema" });
    const behavior = { decision: "behavior" as const, score: .9, reason: "replace schema lookup algorithm", sources: [VERSION], revisedMethod: "Use a versioned local registry before editing." };
    let createdVersion = "";

    await reviewExperiences({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async (_version, hint) => {
      assert.equal(hint, behavior.revisedMethod);
      createdVersion = "experience-v2";
      await commit(setup.writer, createdVersion, hint);
    }, model: { review: async () => behavior } }, await setup.store.load(), new AbortController().signal);
    assert.equal(createdVersion, "experience-v2");
    await register(setup.store, createdVersion);
    const after = await setup.store.load();
    const choicesAfter = await runtimeFor(setup.store).context(context("after-behavior"));

    assert.equal(choicesAfter.some(item => item.versionId === VERSION), false, "replaced original must be absent from normal candidates");
    assert.equal(choicesAfter.find(item => item.versionId === createdVersion)?.stable, false);
    assert.equal(evidenceOf(after.observations, { versionId: createdVersion }).successes, 0);
    assert.ok(choicesAfter.find(item => item.versionId === createdVersion)?.compact.includes(behavior.revisedMethod));
    assert.ok((await repaired.expand(VERSION)).includes(ORIGINAL), "archived original remains traceable on demand");
  });
});

test("recent negative feedback removes stable default consumption and late positives cannot resurrect the exited epoch", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    const lateFeedback = await use(setup, "late-known-later");

    await accumulate(setup, 12, "changed", false);
    await reviewExperiences({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {} }, await setup.store.load(), new AbortController().signal);
    const restarted = runtimeFor(createExperienceStore(setup.root, () => AT));
    const choices = await restarted.context(context("after-exit"));

    assert.equal(choices[0]?.stable, false, "a withdrawn legacy compact cannot remain a default compilation");
    assert.equal((await restarted.slot("after-exit"))?.message.content.includes("稳定经验 默认起点"), false);
    assert.ok((await setup.writer.recordFeedback(lateFeedback)).ok, "late positive can be stored as the old use's historical report");
    assert.equal(snapshotOf(await setup.store.load(), scopesOf(await setup.store.load(), VERSION)[0]!.hypothesis).evidence.successes, 10,
      "compiled reports never rewrite original source qualification");
  });
});

test("correcting a referenced observation removes mature consumption while retaining valid historical review through compaction", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    const before = await setup.store.load();
    const original = before.observations[0]!;

    assert.ok((await setup.writer.recordFeedback({ writeId: "correction-after-promotion", versionId: VERSION,
      turnId: original.taskId, exposureId: `exposure-${original.taskId}`, helped: false, observedAt: AT,
      observation: { ...original, revision: 1, outcome: "unhelpful" } })).ok);
    const compacted = await withBoardWriter(setup.root, async store => {
      const loaded = await store.load();
      assert.ok(loaded.ok);
      return store.compact(loaded.generation);
    });

    assert.ok(compacted.ok, "a legitimate correction cannot make the historical Board snapshot unrecoverable");
    const after = await createExperienceStore(setup.root, () => AT).load();

    assert.equal(after.facts.filter(item => item.kind === "review").length, 1, "retain the original review as historical evidence");
    assert.equal((await runtimeFor(createExperienceStore(setup.root, () => AT)).context(context("corrected-followup")))[0]?.stable, false);
    assert.equal(evidenceOf(after.observations, { versionId: VERSION }).successes, 9);
    assert.equal(evidenceOf(after.observations, { versionId: VERSION }).failures, 1);
  });
});

test("legacy stable labels never fabricate mature experience and forged restored reviews fail closed", async () => {
  await usingBoard(async setup => {
    const raw = await createBoardReader(setup.root).load();

    assert.ok(raw.ok);
    const legacy = normalizeBoardState({ ...raw.state, methodRetentions: [{ versionId: VERSION, layer: "stable", retention: "retained", recordedAt: AT }] });

    assert.ok(legacy);
    const legacyView = { ...(await setup.store.load()), variants: (await setup.writer.load()).ok ?
      (await setup.store.load()).variants.map(item => ({ ...item, layer: "stable" as const })) : [] };
    const runtime = createExperienceRuntime({ store: { load: async () => legacyView, append: setup.store.append }, emit: () => {}, correct: async () => {}, revise: async () => {} });

    assert.equal((await runtime.context(context("legacy-followup")))[0]?.stable, false);
    const view = await setup.store.load();
    const scope = scopesOf(view, VERSION)[0]!.hypothesis;
    const snapshot = snapshotOf(view, scope);
    const forged = normalizeBoardState({ ...raw.state, sequence: raw.state.sequence + 1,
      methodExperienceFacts: [...(raw.state.methodExperienceFacts ?? []), { kind: "review", factId: "forged-review", versionId: VERSION,
        sequence: raw.state.sequence + 1, scopeId: "base", snapshotId: snapshot.snapshotId,
        evidenceRevisions: [], review: promotion() }] });

    assert.equal(forged, undefined, "restored stable reviews must satisfy the same dual gate as live writes");
  });
});

test("scope restriction changes catalog and actual matching without deleting failures or increasing confidence", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    await use(setup, "restriction-counterexample", false);
    await setup.runtime.context({ ...context("restricted-context"), features: { format: "json", encoding: "legacy" } });
    await setup.runtime.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "legacy encoding invalidates parser assumptions" });
    const before = await setup.store.load();
    const scope = scopesOf(before, VERSION)[0]!.hypothesis;
    const narrow: ExperienceReview = { decision: "narrow", score: .9, reason: "exclude only legacy encoding", sources: [VERSION],
      scopes: [{ ...scope, proposedSequence: 0, predicate: { all: scope.predicate.all, exclude: [{ feature: "encoding", value: "legacy" }] } }] };

    await reviewExperiences({ store: setup.store, emit: () => {}, correct: async () => {}, revise: async () => {},
      model: { review: async () => narrow } }, before, new AbortController().signal);
    const after = await setup.store.load();

    assert.equal(snapshotOf(after, scope).posterior.confidence, snapshotOf(before, scope).posterior.confidence);
    assert.equal(snapshotOf(after, scope).evidence.successes, 10);
    assert.equal(snapshotOf(after, scope).evidence.failures, 0, "the preserved counterexample belongs to the delivered compilation");
    assert.ok(after.observations.some(item => item.taskId === "restriction-counterexample" && item.outcome === "unhelpful" && item.compilationId !== undefined));
    const restarted = runtimeFor(createExperienceStore(setup.root, () => AT));
    const catalog = await restarted.catalog();

    assert.ok(catalog.includes("encoding") && catalog.includes("legacy"), "execution must see the effective scope exclusion");
    assert.equal((await restarted.context({ ...context("supported"), features: { format: "json", encoding: "modern" } },
      { versionId: VERSION, scopeId: "base" }))[0]?.stable, false, "artifact-free narrowing retains only a deliberate source trial");
    assert.deepEqual(await restarted.context({ ...context("excluded"), features: { format: "json", encoding: "legacy" } }), []);
  });
});

test("synthesis requires mature related sources, preserves separate evidence and suppresses covered source slots", async () => {
  await usingBoard(async setup => {
    const second = "experience-related";

    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    await commit(setup.writer, second, "Check the local schema version before modifying a structured payload.");
    await register(setup.store, second);
    await setup.runtime.context(context("request-synthesis"));
    await setup.runtime.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "combine redundant schema instructions" });
    const synthesis = { ...promotion(), decision: "expression" as const, sources: [VERSION, second],
      compact: { ...COMPACT, action: "Resolve the local schema version, validate, then edit once." } };

    await assert.rejects(appendReview(setup.store, synthesis), /invalid_feedback/, "unmature related text cannot contribute stable credibility");
    await accumulate(setup, 10, "related", true, second);
    await appendReview(setup.store, { ...promotion(), sources: [second] }, second);
    await appendReview(setup.store, synthesis);
    const view = await setup.store.load();

    assert.equal(evidenceOf(view.observations, { versionId: VERSION }).successes, 10);
    assert.equal(evidenceOf(view.observations, { versionId: second }).successes, 10);
    const restarted = runtimeFor(createExperienceStore(setup.root, () => AT));
    const selected = await restarted.context(context("merged-followup"));

    assert.equal(selected.length, 1, "combined expression replaces its covered source expressions");
    assert.ok(selected[0]?.compact.includes(synthesis.compact.action));
    assert.deepEqual(new Set(selected[0]?.sourceVersionIds), new Set([VERSION, second]));
    assert.equal((await restarted.slot("merged-followup"))?.receipts.length, 1);
    await setup.store.append(source => ({ kind: "exit", factId: "related-source-withdrawn", versionId: second,
      sequence: source.sequence + 1, scopeId: "base", mode: "stable", reason: "source judgment has been withdrawn" }));
    const invalidated = runtimeFor(createExperienceStore(setup.root, () => AT));

    assert.equal((await invalidated.context(context("after-related-exit"))).find(item => item.versionId === VERSION)?.stable, false);
    assert.equal((await invalidated.slot("after-related-exit"))?.message.content.includes(synthesis.compact.action), false,
      "an aggregate cannot remain the default after a bound source loses maturity");
  });
});

test("restart completes interrupted persisted review effects without another model call or duplicate writes", async () => {
  await usingBoard(async setup => {
    await accumulate(setup, 10);
    await appendReview(setup.store, promotion());
    await setup.runtime.context({ ...context("repair-before-crash"), features: { format: "json", mode: "local" } });
    await setup.runtime.decide({ versionId: VERSION, scopeId: "base", action: "block", reason: "old scope is too broad" });
    const before = await setup.store.load();
    const original = scopesOf(before, VERSION)[0]!.hypothesis;
    const narrow: ExperienceReview = { decision: "narrow", score: .9, reason: "confirm local tasks prospectively", sources: [VERSION],
      scopes: [{ ...original, id: "local-after-crash", scopeId: "local", proposedSequence: 0,
        predicate: { all: [...original.predicate.all, { feature: "mode", value: "local" }], exclude: [] } }] };
    let injectFailure = true;
    let initialModelCalls = 0;
    const faultingStore: ExperienceStore = { load: setup.store.load, append: make => setup.store.append(source => {
      const fact = make(source);
      if (fact.kind === "exit" && injectFailure) {
        injectFailure = false;
        throw new Error("injected_post_review_write_failure");
      }
      return fact;
    }) };

    await assert.rejects(reviewExperiences({ store: faultingStore, emit: () => {}, correct: async () => {}, revise: async () => {},
      model: { review: async () => {
        initialModelCalls += 1;
        return narrow;
      } } }, before, new AbortController().signal), /method_experience_write/);
    assert.equal(initialModelCalls, 1);
    const interrupted = await setup.store.load();

    assert.equal(interrupted.facts.filter(item => item.kind === "review" && item.review.decision === "narrow").length, 1);
    assert.equal(interrupted.facts.filter(item => item.kind === "exit").length, 0);
    assert.equal(scopesOf(interrupted, VERSION).length, 1);
    const pending = runtimeFor(setup.store);

    assert.equal((await pending.context({ ...context("pending-followup"), features: { format: "json", mode: "local" } }))[0]?.stable, false,
      "a persisted corrective judgment revokes the old default before its remaining effects are committed");
    let recoveryModelCalls = 0;
    const restarted = () => createExperienceRuntime({ store: createExperienceStore(setup.root, () => AT), emit: () => {},
      correct: async () => {}, revise: async () => {}, model: { review: async () => {
        recoveryModelCalls += 1;
        throw new Error("recovery_must_not_ask_model_again");
      } } });

    await restarted().endTurn();
    const recovered = await setup.store.load();

    assert.equal(recoveryModelCalls, 0);
    assert.equal(recovered.facts.filter(item => item.kind === "exit" && item.mode === "scope" && item.scopeId === "base").length, 1);
    const local = scopesOf(recovered, VERSION).find(item => item.hypothesis.scopeId === "local")!.hypothesis;

    assert.ok(local.proposedSequence >= interrupted.sequence, "new scope cannot inherit pre-crash favorable history");
    assert.equal(snapshotOf(recovered, local).evidence.successes, 0);
    assert.deepEqual(evidenceOf(recovered.observations, { versionId: VERSION }), evidenceOf(before.observations, { versionId: VERSION }));
    const selected = await restarted().context({ ...context("recovered-followup"), features: { format: "json", mode: "local" } });

    assert.deepEqual(selected.map(item => item.scopeId), ["local"]);
    assert.equal(selected[0]?.stable, false);
    await restarted().endTurn();
    assert.equal((await setup.store.load()).sequence, recovered.sequence, "repeat recovery must not append effects again");
    assert.equal(recoveryModelCalls, 0);
  });
});
