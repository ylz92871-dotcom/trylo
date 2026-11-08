import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../../adapters/learning-store/file-event-store.js";
import { createFileVerificationRegistry, type FileVerificationRegistry } from "../../adapters/verification-authority-store/index.js";
import { evaluateCandidate } from "../../evaluation/evaluator.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { BoardState } from "../../learning/control/state.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";
import { learnedSkillCatalog, decodeLearnedSkillContent } from "./catalog.js";
import { createSkillLearningSubsystem } from "./runtime.js";
import type { SkillExperience, SkillLearningDependencies, SkillLearningGrant, SkillOpportunity, SkillTrialRequest, SkillTrialResult } from "./runtime-contract.js";

const AT = "2026-11-03T00:00:00.000Z";
const FAMILY: TaskFamily = { id: "report-a", intentClass: "normalize_report", checkKind: "acceptance", language: "json", checkSchema: "rows-v1" };
const GRANT: SkillLearningGrant = { subsystem: "skill", allowance: { maxEpisodes: 32, maxInputBytes: 131072, maxEvaluations: 1 } };
const STEPS = ["parse structured report", "keep zero-valued rows", "check exact report"];

type Harness = {
  readonly root: string;
  readonly store: BoardStore;
  readonly registry: FileVerificationRegistry;
  readonly deps: SkillLearningDependencies;
  readonly writes: BoardCommand[];
  readonly trials: SkillTrialRequest[];
  facts: SkillExperience[];
  collection: "enabled" | "disabled";
  opportunityCalls: number;
  evaluate: (request: SkillTrialRequest) => Promise<SkillTrialResult>;
};

function experience(id: string, outcome: "success" | "failure", family: TaskFamily = FAMILY): SkillExperience {
  return { workspaceId: "workspace-a", runId: `run:${id}`, sourceRef: `execution:${id}`,
    qualification: { kind: "external_check", ref: `execution:check:${id}` },
    episode: { id, taskFamily: family, outcome, steps: STEPS, checks: ["independent exact report checker"],
      trajectory: { nodeIds: ["read", "transform", "check"], stepCount: 3, hadChecks: true, hadFailureRecovery: outcome === "failure" },
      ...(outcome === "failure" ? { failureMode: "truthiness filtering drops zero amounts" } : {}) } };
}

function familyFacts(prefix = "a", family: TaskFamily = FAMILY): SkillExperience[] {
  return [experience(`${prefix}-success-1`, "success", family), experience(`${prefix}-success-2`, "success", family), experience(`${prefix}-failure`, "failure", family)];
}

function explicitCorrection(id: string): SkillExperience {
  const failed = experience(id, "failure");
  return { ...failed, qualification: { kind: "explicit_correction", ref: `user_explicit:${id}` },
    episode: { ...failed.episode, correction: { targetEpisodeIds: ["a-success-1", "a-success-2"],
      scope: "condition", reason: "this condition requires keeping input order" } } };
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-skill-runtime-"));
  const store = createFileBoardStore(path.join(root, "board"));

  assert.ok("apply" in store, JSON.stringify(store));
  let receipt = 0;
  const registry = createFileVerificationRegistry({ path: path.join(root, "authority", "receipts.ndjson"), clock: () => AT, idFactory: domain => `${domain}:${++receipt}` });
  const writes: BoardCommand[] = [], trials: SkillTrialRequest[] = [];
  const board: BoardStore = {
    apply: command => {
      writes.push(command);
      return store.apply(command);
    },

    load: () => store.load(), snapshot: generation => store.snapshot(generation),
    compact: generation => store.compact(generation), close: () => store.close(),
  };
  const h: Harness = {
    root, store, registry, writes, trials, facts: familyFacts(), collection: "enabled", opportunityCalls: 0,
    evaluate: request => validTrial(h, request),
    deps: { board, authority: { verify: registry.verify }, now: () => AT, collection: () => h.collection,

      opportunity: async () => {
        h.opportunityCalls += 1;
        return opportunity(h);
      },

      evaluate: async request => {
        trials.push(request);
        return h.evaluate(request);
      } },
  };

  try { await run(h); }
  finally {
    await store.close();
    // mkdtemp owns exactly this generated child of tmpdir; never remove a computed ancestor.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-skill-runtime-"));
    rmSync(root, { recursive: true, force: true });
  }
}

function opportunity(h: Harness): SkillOpportunity {
  return { opportunityId: `runtime-opportunity-${h.opportunityCalls}`, workspaceId: "workspace-a", collection: h.collection, experiences: h.facts };
}

async function state(h: Harness): Promise<BoardState> {
  const loaded = await h.store.load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  return loaded.state;
}

async function validTrial(h: Harness, request: SkillTrialRequest, version = request.versionId): Promise<Extract<SkillTrialResult, { kind: "evidence" }>> {
  const evidence = evaluateCandidate({ proposalId: request.content.draft.id, baselineRef: request.baselineVersionId ?? "baseline:loses-zero",
    candidateRef: request.versionId, generatorRoleId: "skill_inducer", evaluatorRoleId: "independent-report-checker",
    baselineAnchors: [{ kind: "test", result: "fail", ref: "execution:baseline", selfGenerated: false }],
    candidateAnchors: ["new-report-a", "new-report-b"].map(id => ({ kind: "test", result: "pass", ref: `execution:check:${id}`, selfGenerated: false })),
    weakSignals: [], costDelta: 0, latencyDelta: 0, outputLengthDelta: 0, criticalRegressionFailed: false, failureDiversity: 1, sampleSize: 2 });
  const issued = await h.registry.issue({ domain: "user_explicit", subject: { subjectKind: "content_candidate", subjectId: request.content.draft.id,
    subjectVersion: version, scope: request.scope }, generatorId: "skill_inducer", verifierId: "independent-report-checker", issuedAt: AT,
    sourceFactRef: "execution:check:new-report-a" });

  assert.ok(issued.ok, JSON.stringify(issued));

  return { kind: "evidence", receiptRef: issued.receipt.receiptId, evidence };
}

function catalog(h: Harness, current: BoardState) {
  return learnedSkillCatalog({ state: current, contentRoot: h.root, context: { workspaceId: "workspace-a", taskFamily: FAMILY } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("standalone grant lets the subsystem choose a complete family without caller lesson selection", async () => withHarness(async h => {
  const other: TaskFamily = { ...FAMILY, id: "report-b" };
  const correction: SkillExperience = {
    ...experience("z-late-correction", "failure"), qualification: { kind: "explicit_correction", ref: "user_explicit:late-correction" },
    episode: { ...experience("z-late-correction", "failure").episode,
      correction: { targetEpisodeIds: ["a-success-1", "a-success-2"], scope: "condition", reason: "this condition requires keeping input order" } },
  };

  h.facts = [...familyFacts("b", other), ...familyFacts(), correction];
  const learning = createSkillLearningSubsystem(h.deps);
  const grant = { subsystem: "skill" as const, allowance: { ...GRANT.allowance, maxEpisodes: 3 } };
  const result = await learning.learn(grant);

  assert.equal(result.status, "shadow", JSON.stringify(result));
  assert.equal(result.usage.episodes, 3);
  assert.equal(h.trials[0]?.content.draft.taskFamily.id, "report-b");
  assert.deepEqual(h.trials[0]?.content.draft.provenance.observationRefs, ["b-failure", "b-success-1", "b-success-2"]);
  assert.equal(h.trials.length, 1, "large unrelated history cannot consume another family's allowance");
  h.facts = [...familyFacts(), correction];
  const tooSmall = await learning.learn(grant);

  assert.equal(tooSmall.reason, "family_exceeds_allowance");
  assert.equal(h.trials.length, 1, "must not crop off the late correction to learn a stale path");
  const complete = await learning.learn({ ...grant, allowance: { ...grant.allowance, maxEpisodes: 4 } });

  assert.equal(complete.status, "waiting");
  assert.equal(complete.reason, "needs_more_evidence");
  assert.equal(complete.usage.episodes, 4);
  assert.equal(h.trials.length, 1, "the complete family contains a correction that invalidates both old successes");
}));

test("collection disabled prevents opportunity and evaluator calls", async () => withHarness(async h => {
  h.collection = "disabled";
  const result = await createSkillLearningSubsystem(h.deps).learn(GRANT);

  assert.equal(result.status, "disabled");
  assert.equal(h.opportunityCalls, 0);
  assert.equal(h.trials.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal((await state(h)).sequence, 0);
}));

test("input byte allowance defers the whole family without partial persistence", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);
  const result = await learning.learn({ ...GRANT, allowance: { ...GRANT.allowance, maxInputBytes: 64 } });

  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "family_exceeds_allowance");
  assert.equal(h.writes.length, 0);
  assert.equal(h.trials.length, 0);
  assert.equal((await state(h)).assets.length, 0);
  const admitted = await learning.learn(GRANT);

  assert.equal(admitted.status, "shadow");
  assert.ok(admitted.usage.inputBytes > 64 && admitted.usage.inputBytes <= GRANT.allowance.maxInputBytes);
}));

test("zero evaluation allowance saves an unexposed draft and resumes the same version; identical digest is unchanged", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);
  const waiting = await learning.learn({ ...GRANT, allowance: { ...GRANT.allowance, maxEvaluations: 0 } });

  assert.equal(waiting.reason, "evaluation_allowance_exhausted");
  assert.equal(h.trials.length, 0);
  const saved = await state(h);

  assert.equal(saved.assets.length, 1);
  assert.equal(saved.evidence.length, 0);
  assert.equal(catalog(h, saved).catalog, undefined);
  const resumed = await learning.learn(GRANT);

  assert.equal(resumed.status, "shadow", JSON.stringify(resumed));
  assert.equal(resumed.versionId, waiting.versionId);
  assert.equal((await state(h)).assets.length, 1);
  assert.ok(catalog(h, await state(h)).catalog);
  const writes = h.writes.length;

  h.facts.reverse();
  const duplicate = await learning.learn(GRANT);

  assert.equal(duplicate.status, "unchanged");
  assert.equal(h.writes.length, writes);
  assert.equal(h.trials.length, 1);
}));

test("missing and wrong-version real authority receipts never expose the skill", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);

  for (const mode of ["missing", "unknown", "stale"] as const) {
    h.evaluate = async request => {
      const trial = await validTrial(h, request, mode === "stale" ? "wrong-version" : request.versionId);
      return { ...trial, receiptRef: mode === "missing" ? "" : mode === "unknown" ? "never-issued" : trial.receiptRef };
    };
    const result = await learning.learn(GRANT);

    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.reason, mode === "missing" ? "missing_verification_ref" : mode === "unknown" ? "verification_receipt_unavailable" : "verification_binding_mismatch");
    const current = await state(h);

    assert.equal(current.evidence.length, 0);
    assert.equal(current.activations.length, 0);
    assert.equal(current.assets.length, 1);
    assert.equal(catalog(h, current).catalog, undefined);
  }

  h.evaluate = request => validTrial(h, request);
  assert.equal((await learning.learn(GRANT)).status, "shadow");
  assert.equal((await state(h)).assets.length, 1);
}));

for (const stop of ["cancelled", "disabled"] as const) {
  test(`${stop} after awaited opportunity writes no learning state`, async () => withHarness(async h => {
    const entered = deferred<void>(), proceed = deferred<SkillOpportunity>(), controller = new AbortController();
    const learning = createSkillLearningSubsystem({ ...h.deps, opportunity: async () => {
      entered.resolve();
      return proceed.promise;
    } });
    const running = learning.learn(GRANT, controller.signal);

    await entered.promise;

    if (stop === "cancelled") controller.abort(); else h.collection = "disabled";

    proceed.resolve(opportunity(h));
    assert.equal((await running).status, stop);
    assert.equal(h.writes.length, 0);
    assert.equal(h.trials.length, 0);
  }));

  test(`${stop} after awaited evaluation preserves draft without admitting evidence`, async () => withHarness(async h => {
    const entered = deferred<SkillTrialRequest>(), proceed = deferred<SkillTrialResult>(), controller = new AbortController();

    h.evaluate = request => {
      entered.resolve(request);
      return proceed.promise;
    };
    const running = createSkillLearningSubsystem(h.deps).learn(GRANT, controller.signal);
    const request = await entered.promise;
    const before = await state(h), writes = h.writes.length;

    if (stop === "cancelled") controller.abort(); else h.collection = "disabled";

    proceed.resolve(await validTrial(h, request));
    assert.equal((await running).status, stop);
    const after = await state(h);

    assert.equal(after.sequence, before.sequence);
    assert.equal(h.writes.length, writes);
    assert.equal(after.assets.length, 1);
    assert.equal(after.evidence.length, 0);
    assert.equal(after.activations.length, 0);
  }));

  test(`${stop} while authority verification is awaited cannot write afterwards`, async () => withHarness(async h => {
    const entered = deferred<void>(), proceed = deferred<void>(), controller = new AbortController();
    const learning = createSkillLearningSubsystem({ ...h.deps, authority: { verify: async (reference, expected) => {
      entered.resolve();
      await proceed.promise;
      return h.registry.verify(reference, expected);
    } } });
    const running = learning.learn(GRANT, controller.signal);

    await entered.promise;
    const before = await state(h), writes = h.writes.length;

    if (stop === "cancelled") controller.abort(); else h.collection = "disabled";

    proceed.resolve();
    assert.equal((await running).status, stop);
    assert.equal((await state(h)).sequence, before.sequence);
    assert.equal(h.writes.length, writes);
  }));
}

test("feedback must bind the exact hash; late feedback for a replaced version cannot revoke its replacement", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);
  const first = await learning.learn(GRANT);
  assert.equal(first.status, "shadow");
  const v1 = (await state(h)).assets.find(asset => asset.versionId === first.versionId);
  assert.ok(v1);
  const content = decodeLearnedSkillContent(v1.content);
  assert.ok(content);
  const variant = content.draft.variants[0];
  assert.ok(variant);
  h.facts.push(experience("later-success", "success"));
  const second = await learning.learn(GRANT);
  assert.equal(second.status, "shadow", JSON.stringify(second));
  assert.notEqual(second.versionId, first.versionId);
  const before = await state(h), writes = h.writes.length;
  const feedback = { ...experience("late-failure", "failure"), runId: h.facts[0]!.runId,
    usedSkill: { versionId: v1.versionId, variantId: variant.id, contentHash: "wrong-content-hash" } };

  h.facts.push(feedback);
  const mismatched = await learning.learn(GRANT);

  assert.equal(mismatched.reason, "feedback_binding_mismatch");
  assert.equal(mismatched.status, "failed");
  assert.equal((await state(h)).sequence, before.sequence);
  assert.equal(h.writes.length, writes);
  h.facts[h.facts.length - 1] = { ...feedback, usedSkill: { ...feedback.usedSkill, contentHash: v1.contentHash },
    episode: { ...feedback.episode, taskFamily: { ...FAMILY, checkSchema: "different-checker-condition" } } };
  const wrongConditions = await learning.learn(GRANT);

  assert.equal(wrongConditions.reason, "feedback_binding_mismatch");
  assert.equal((await state(h)).sequence, before.sequence);
  assert.equal(h.writes.length, writes);
  h.facts[h.facts.length - 1] = { ...feedback, usedSkill: { ...feedback.usedSkill, contentHash: v1.contentHash } };
  const waiting = await learning.learn({ ...GRANT, allowance: { ...GRANT.allowance, maxEvaluations: 0 } });

  assert.equal(waiting.reason, "evaluation_allowance_exhausted");
  const after = await state(h);

  assert.ok(after.activations.some(item => item.versionId === second.versionId && item.pointer === "shadow"));
  assert.equal(h.writes.slice(writes).some(command => command.type === "reject" || command.type === "suspend"), false);
  assert.equal(after.assets.length, 3, "late feedback can support a new unverified draft without revoking the replacement");
  assert.ok(catalog(h, after).catalog);
}));

test("a corrected current family cannot be bypassed by another independently learnable family", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);

  assert.equal((await learning.learn(GRANT)).status, "shadow");
  const trialCount = h.trials.length;

  h.facts.push(explicitCorrection("late-correction"), ...familyFacts("b", { ...FAMILY, id: "report-b" }));
  const result = await learning.learn(GRANT);

  assert.equal(result.status, "waiting", JSON.stringify(result));
  assert.equal(result.reason, "needs_more_evidence");
  assert.equal(h.trials.length, trialCount, "an unrelated candidate must not defer invalidation of the current corrected procedure");
  const current = await state(h);

  assert.equal(catalog(h, current).catalog, undefined);
  assert.equal(current.assets.length, 1, "this opportunity first processes the pending correction");
}));

test("an explicit correction without usage metadata still withdraws the current path it identifies", async () => withHarness(async h => {
  const learning = createSkillLearningSubsystem(h.deps);
  const first = await learning.learn(GRANT);
  assert.equal(first.status, "shadow");
  const correction = explicitCorrection("no-usage-correction");

  assert.equal(correction.usedSkill, undefined);
  h.facts.push(correction);
  const result = await learning.learn(GRANT);

  assert.equal(result.status, "waiting");
  assert.equal(h.trials.length, 1);
  const current = await state(h);

  assert.equal(catalog(h, current).catalog, undefined);
  assert.equal(current.proposals.find(proposal => proposal.proposalId === first.proposalId)?.lifecycle, "rejected");
  assert.ok(h.writes.some(command => command.type === "reject" && command.proposalId === first.proposalId));
}));

test("one bounded learning grant can consume multiple comparable families internally", async () => withHarness(async h => {
  h.facts.push(...familyFacts("b", { ...FAMILY, id: "report-b" }));
  const grant = { ...GRANT, allowance: { ...GRANT.allowance, maxEvaluations: 2, maxCycles: 3 } };
  const result = await createSkillLearningSubsystem(h.deps).learn(grant);

  assert.equal(result.status, "shadow", JSON.stringify(result));
  assert.equal(h.trials.length, 2);
  assert.equal((await state(h)).assets.length, 2);
  assert.ok(result.usage.episodes <= grant.allowance.maxEpisodes);
  assert.ok(result.usage.evaluations <= grant.allowance.maxEvaluations);
}));

test("a growing task family uses a traceable bounded evidence window instead of permanently exceeding 256 records", async () => withHarness(async h => {
  h.facts = [...Array.from({ length: 300 }, (_, i) => experience(`success-${String(i).padStart(4, "0")}`, "success")), experience("failure", "failure")];
  const result = await createSkillLearningSubsystem(h.deps).learn({ ...GRANT, allowance: { ...GRANT.allowance, maxEpisodes: 8 } });

  assert.equal(result.status, "shadow", JSON.stringify(result));
  assert.ok(result.usage.episodes <= 8);
  const content = decodeLearnedSkillContent((await state(h)).assets[0]?.content);
  assert.ok(content);
  const window = content.sourceWindow;

  assert.ok(window && window.omittedCount > 0 && window.selectedEpisodeIds.length <= 8);
}));

test("a bounded window retains late corrections and the old demonstration targets", async () => withHarness(async h => {
  h.facts = [...Array.from({ length: 300 }, (_, i) => experience(`success-${String(i).padStart(4, "0")}`, "success")), experience("failure", "failure")];
  const correction = experience("z-correction", "failure");

  h.facts.push({ ...correction, qualification: { kind: "explicit_correction", ref: "user_explicit:correction" },
    episode: { ...correction.episode, correction: { targetEpisodeIds: ["success-0000", "success-0001"],
      scope: "condition", reason: "preserve row order" } } });
  const replacement = experience("replacement-success", "success");

  h.facts.push({ ...replacement, episode: { ...replacement.episode, steps: ["parse structured report", "preserve row order", "check exact report"] } });
  const result = await createSkillLearningSubsystem(h.deps).learn({ ...GRANT, allowance: { ...GRANT.allowance, maxEpisodes: 8 } });

  assert.equal(result.status, "shadow", JSON.stringify(result));
  assert.ok(h.trials[0]?.content.draft.steps.includes("preserve row order"));
  const refs = h.trials[0]?.content.sourceWindow?.selectedEpisodeIds ?? [];

  for (const ref of ["z-correction", "success-0000", "success-0001"]) assert.ok(refs.includes(ref), ref);
}));

test("a rejected candidate can try another observed complete method on a later opportunity", async () => withHarness(async h => {
  const alternate = experience("alternate-success", "success");

  h.facts.push({ ...alternate, episode: { ...alternate.episode, steps: ["read validated input", "transform without filtering", "check exact report"] } });
  h.evaluate = async request => {
    const trial = await validTrial(h, request);
    return h.trials.length === 1 ? { ...trial, evidence: { ...trial.evidence, verdict: "reject", externalPass: false, shadowRecommended: false } } : trial;
  };
  const learning = createSkillLearningSubsystem(h.deps);

  assert.equal((await learning.learn(GRANT)).reason, "trial_rejected");
  const restarted = createSkillLearningSubsystem(h.deps);
  const next = await restarted.learn(GRANT);

  assert.equal(next.status, "shadow", JSON.stringify(next));
  assert.notEqual(h.trials[0]?.versionId, h.trials[1]?.versionId);
  assert.notDeepEqual(h.trials[0]?.content.draft.steps, h.trials[1]?.content.draft.steps);
}));

test("a persisted waiting trial resumes only after a new independent evidence revision", async () => withHarness(async h => {
  let revision: string | undefined;
  const deps = { ...h.deps, opportunity: async () => ({ ...opportunity(h), opportunityId: "fixed-opportunity",
    ...(revision === undefined ? {} : { trialRevision: revision }) }) };

  h.evaluate = async () => ({ kind: "waiting", reason: "independent_execution_pending" });
  const first = await createSkillLearningSubsystem(deps).learn(GRANT);

  assert.equal(first.reason, "independent_execution_pending");
  const waiting = await createSkillLearningSubsystem(deps).learn(GRANT);

  assert.equal(waiting.reason, "trial_waiting_new_opportunity");
  assert.equal(h.trials.length, 1, "restarts must not repeat an already waiting provider trial");
  revision = "independent-receipt-arrived";
  h.evaluate = request => validTrial(h, request);
  const resumed = await createSkillLearningSubsystem(deps).learn(GRANT);

  assert.equal(resumed.status, "shadow");
  assert.equal(resumed.versionId, first.versionId);
  assert.equal((await state(h)).assets.length, 1);
  assert.equal(h.trials.length, 2);
}));

test("an interrupted running trial can resume its same candidate after restart", async () => withHarness(async h => {
  const deps = { ...h.deps, opportunity: async () => ({ ...opportunity(h), opportunityId: "crashed-trial" }) };

  h.evaluate = async () => { throw new Error("provider disconnected before delivering independent evidence"); };
  const failed = await createSkillLearningSubsystem(deps).learn(GRANT);

  assert.equal(failed.status, "failed");
  assert.equal((await state(h)).jobs[0]?.state, "running");
  h.evaluate = request => validTrial(h, request);
  const resumed = await createSkillLearningSubsystem(deps).learn(GRANT);

  assert.equal(resumed.status, "shadow");
  assert.equal(resumed.versionId, failed.versionId);
  assert.equal((await state(h)).assets.length, 1);
}));

test("rejected retries are bounded across opportunities and fresh qualified evidence releases the wait", async () => withHarness(async h => {
  h.evaluate = async request => {
    const trial = await validTrial(h, request);
    return { ...trial, evidence: { ...trial.evidence, verdict: "reject", externalPass: false, shadowRecommended: false } };
  };

  for (let index = 0; index < 3; index += 1) assert.equal((await createSkillLearningSubsystem(h.deps).learn(GRANT)).reason, "trial_rejected");

  const stopped = await createSkillLearningSubsystem(h.deps).learn(GRANT);

  assert.equal(stopped.reason, "rejected_waiting_new_evidence");
  assert.equal(h.trials.length, 3);
  assert.equal((await state(h)).assets.length, 3);
  h.facts.push(experience("new-independent-success", "success"));
  h.evaluate = request => validTrial(h, request);
  assert.equal((await createSkillLearningSubsystem(h.deps).learn(GRANT)).status, "shadow");
}));

test("a crash after durable independent evidence resumes without rewriting that evidence", async () => withHarness(async h => {
  const board: BoardStore = { ...h.deps.board, apply: command => {
    if (command.type === "enter_shadow") throw new Error("process stopped after durable evidence");
    return h.deps.board.apply(command);
  } };

  assert.equal((await createSkillLearningSubsystem({ ...h.deps, board }).learn(GRANT)).status, "failed");
  assert.equal((await state(h)).evidence.length, 1);
  const resumed = await createSkillLearningSubsystem(h.deps).learn(GRANT);

  assert.equal(resumed.status, "shadow", JSON.stringify(resumed));
  assert.equal(resumed.versionId, h.trials[0]?.versionId);
  assert.equal((await state(h)).evidence.length, 1);
}));
