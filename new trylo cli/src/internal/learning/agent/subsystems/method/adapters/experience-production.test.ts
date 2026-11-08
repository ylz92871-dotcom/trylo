import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { matureReview, scopesOf, snapshotOf } from "../domain/experience-state.js";
import { fixture, seed, run, source, cleanupFixture, VERSION, ORIGINAL, COMPACT, type Metrics } from "../testing/production-fixture.js";

test("normal CLI composition accumulates actual uses, defers, compiles, adopts compact content and reduces scripted exploration", async t => {
  const fx = fixture();
  let passed = false;

  try {
    await seed(fx);
    const baseline = await run(fx, "baseline", "k12", { learning: false });
    const runs: Metrics[] = [];

    for (let index = 1; index <= 10; index += 1) runs.push((await run(fx, `train-${index}`, `k${index}`, { review: "defer" })).metrics);

    let view = await source(fx), scope = scopesOf(view, VERSION)[0]!.hypothesis;

    assert.equal(snapshotOf(view, scope).evidence.successes, 10);
    assert.ok(snapshotOf(view, scope).posterior.confidence >= .95);
    assert.equal(matureReview(view, scope), undefined, "an actual low-M deferral must prevent default adoption");
    assert.equal(view.facts.filter(fact => fact.kind === "review").length, 1);

    for (let index = 11; index <= 17; index += 1) {
      runs.push((await run(fx, `confirmation-${index}`, `k${(index - 1) % 16 + 1}`, { review: "promote" })).metrics);
    }

    view = await source(fx);
    scope = scopesOf(view, VERSION)[0]!.hypothesis;
    assert.ok(matureReview(view, scope));
    const adopted = await run(fx, "fresh-host", "k12");

    assert.equal(adopted.metrics.stable, true);
    assert.deepEqual(adopted.metrics.readPaths, ["data/k12.json"]);
    assert.deepEqual(baseline.metrics.readPaths, ["README.md", "index.json", "data/k12.json"]);
    assert.ok(adopted.metrics.promptChars < baseline.metrics.promptChars, JSON.stringify({ baseline: baseline.metrics, adopted: adopted.metrics }));
    const outside = await run(fx, "outside", "k13", { mode: "outside" });

    assert.equal(outside.metrics.stable, false);
    assert.equal(outside.metrics.readPaths.length, 3);
    const loaded = await createBoardReader(fx.board).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.reservations.length, 2, "defer and promote spend exactly two shared review calls");
    assert.equal(loaded.state.feedbacks.filter(item => item.turnId === "fresh-host").length, 1);
    assert.ok(loaded.state.methodExperienceFacts?.some(item => item.kind === "decision" && item.context.taskId === "fresh-host" && item.decision.action === "adopt"));
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "const {createBoardReader}=await import(process.argv[1]);const r=await createBoardReader(process.argv[2]).load();process.stdout.write(JSON.stringify({ok:r.ok,reviews:r.ok?r.state.methodExperienceFacts.filter(f=>f.kind==='review').length:0}));",
      new URL("../../../../../adapters/learning-store/file-event-store.js", import.meta.url).href, fx.board], { encoding: "utf8" });

    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { ok: true, reviews: 2 });
    t.diagnostic(JSON.stringify({ evidence: "scripted engineering only", baseline: baseline.metrics, training: runs,
      adopted: adopted.metrics, outside: outside.metrics, originalHintChars: ORIGINAL.length, compactBodyChars: JSON.stringify(COMPACT).length }));
    passed = true;
  } finally {
    if (passed) { cleanupFixture(fx); }
    else t.diagnostic(`Failure fixture retained at ${fx.root}`);
  }
});

test("a blocking compiled omission disables the version for this task and an expression repair survives fresh planning", async t => {
  const fx = fixture();
  let passed = false;

  try {
    await seed(fx);

    for (let index = 1; index <= 10; index += 1) await run(fx, `block-train-${index}`, `k${index}`);

    const oldView = await source(fx), scope = scopesOf(oldView, VERSION)[0]!.hypothesis;
    const oldCompilation = matureReview(oldView, scope);
    assert.ok(oldCompilation);
    const moved = path.join(fx.workspace, "moved", "k14.json");

    writeFileSync(moved, readFileSync(path.join(fx.workspace, "data", "k14.json")));
    rmSync(path.join(fx.workspace, "data", "k14.json"));
    const index = JSON.parse(readFileSync(path.join(fx.workspace, "index.json"), "utf8"));

    index.entries.k14 = "moved/k14.json";
    writeFileSync(path.join(fx.workspace, "index.json"), JSON.stringify(index));
    const blocked = await run(fx, "block-use", "k14", { mode: "block", review: "expression" });

    assert.deepEqual(blocked.metrics.readPaths, ["data/k14.json", "index.json", "moved/k14.json"]);
    let view = await source(fx);

    assert.ok(view.facts.some(fact => fact.kind === "decision" && fact.decision.action === "block" && fact.context.taskId === "block-use"));
    const repaired = matureReview(view, scope);
    assert.ok(repaired);
    assert.equal(repaired.review.decision, "expression");
    assert.notEqual(repaired.factId, oldCompilation.factId);
    assert.equal(snapshotOf(view, scope).evidence.successes, 10, "recompilation cannot add a success observation");
    const next = await run(fx, "after-repair", "k14", { mode: "block" });

    assert.deepEqual(next.metrics.readPaths, ["index.json", "moved/k14.json"]);
    assert.deepEqual(next.metrics.reviewDecisions, [], "a consumed blockage must not trigger paid repair again on ordinary later feedback");
    view = await source(fx);
    assert.equal(view.facts.filter(fact => fact.kind === "decision" && fact.context.taskId === "after-repair" && fact.decision.action === "block").length, 0);
    t.diagnostic(JSON.stringify({ evidence: "scripted blocking/repair contract", blocked: blocked.metrics, repaired: next.metrics }));
    passed = true;
  } finally {
    if (passed) { cleanupFixture(fx); }
    else t.diagnostic(`Failure fixture retained at ${fx.root}`);
  }
});
