import { testScratchPath } from "../../../../../testing/scratch.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolResearchDocument, ToolResearchStep } from "../domain/evolution/research.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { toolNpmResearchReferences } from "./installation-research.js";

test("post-acquisition references bind exact installed identity, expose conflicting archive claims, and never claim repository equivalence", async t => {
  const base = testScratchPath("tool-installation-research-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = npmTreeTestData().plan, pkg = installed.tree.root, archive = installed.tree.packages.find(item => item.location === pkg.location);
  assert.ok(archive);
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: installed.tree.scope, capability: "parse tables",
    createdAt: "2026-11-04T00:00:00.000Z", trigger: { runId: "task", proposalKey: "need-api", action: "user_requested", evidenceRefs: [] } };
  const jobId = "research-before-install";
  const add = async (step: number, version: string, documents: readonly ToolResearchDocument[]) => {
    const candidate = { platform: "npm" as const, id: pkg.name, version };
    const research: ToolResearchStep = { type: "tool_learning_research", schemaVersion: 1, jobId, attempt: 1, step,
      scope: plan.scope, capability: plan.capability, occurredAt: plan.createdAt, request: { kind: "inspect", candidate },
      inspection: { status: "complete", candidate, documents } };
    const saved = await withBoardWriter(root, store => savePipelineAsset(store, { kind: "workflow", source: "inferred", issuedAt: plan.createdAt,
      scope: plan.scope, versionId: `tool-research_v1_${contentHashOf({ jobId, step, request: research.request })}`, content: research }));
    assert.ok(saved.ok);
  };
  const metadata = (version: string, integrity: string): ToolResearchDocument => {
    const text = JSON.stringify({ name: pkg.name, version, dist: { tarball: archive.archiveUrl, integrity } });
    return { sourceUrl: `https://registry.npmjs.org/${pkg.name}/${version}`, path: "package.json", kind: "metadata", text, truncated: false,
      contentHash: contentHashOf(text), contentHashBasis: "canonical_rendered_text", basis: { kind: "registry_version_metadata", package: { name: pkg.name, version },
        ...(version === pkg.version ? { archiveClaim: { archiveUrl: archive.archiveUrl, integrity } } : {}) } };
  };

  await add(1, pkg.version, [metadata(pkg.version, archive.integrity)]);
  await add(2, pkg.version, [metadata(pkg.version, `sha512-${Buffer.alloc(64, 7).toString("base64")}`)]);
  await add(3, "99.0.0", [metadata("99.0.0", archive.integrity)]);
  const loaded = await createBoardReader(root).load();
  assert.ok(loaded.ok);
  const references = toolNpmResearchReferences(loaded.state, plan, jobId, installed);
  assert.ok(references.ok);
  assert.deepEqual(references.references.package, { name: pkg.name, version: pkg.version });
  assert.equal(references.references.repositoryTarballEquivalence, "not_established");
  assert.equal(references.references.implementationBasis, "reviewed_installation_files");
  assert.deepEqual(references.references.observations.map(row => row.archiveClaimAlignment), ["same_reviewed_archive_claim", "conflicting_archive_claim"]);
  assert.equal(JSON.stringify(references.references).includes("99.0.0"), false);
  const otherTask = toolNpmResearchReferences(loaded.state, { ...plan, capability: "normalize a different task" }, "later-unrelated-job", installed);

  assert.ok(otherTask.ok);
  assert.deepEqual(otherTask.references.observations, references.references.observations,
    "same exact package API history is reusable across task capabilities without a new network/model request");
  assert.deepEqual(otherTask.references.observations[0]?.origin, { jobId, capability: plan.capability });
  const retiredState = { ...loaded.state, proposals: loaded.state.proposals.map(row => ({ ...row, lifecycle: "retired" as const })) };
  const withdrawn = toolNpmResearchReferences(retiredState, plan, jobId, installed);
  assert.ok(withdrawn.ok);
  assert.deepEqual(withdrawn.references.observations, [], "removed references do not reappear through cross-task reuse");
  const wrongIdentity = { ...loaded.state, assets: loaded.state.assets.map((asset, index) => index === 0
    ? { ...asset, versionId: "tool-research_v1_" + "0".repeat(64) } : asset) };
  const damaged = toolNpmResearchReferences(wrongIdentity, plan, jobId, installed);
  assert.ok(!damaged.ok);
  assert.equal(damaged.code, "invalid_research_asset");
  assert.equal(toolNpmResearchReferences(loaded.state, { ...plan, scope: "foreign-scope" }, jobId, installed).ok, false);
});
