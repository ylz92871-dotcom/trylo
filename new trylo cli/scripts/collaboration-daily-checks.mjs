import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);

function checkMapping(bytes, requirement) {
  let value;

  try { value = JSON.parse(bytes); } catch { return { schemaValid: false, passed: false, actual: null, reason: "invalid_json" }; }

  const schemaValid = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 3
    && value.sourceField === requirement.sourceField && value.targetField === requirement.targetField
    && typeof value.scale === "number" && Number.isFinite(value.scale);
  const actual = schemaValid ? requirement.raw * value.scale : null;

  return { schemaValid, actual, expected: requirement.raw * requirement.scale,
    passed: schemaValid && Math.abs(value.scale - requirement.scale) < 1e-12 };
}

/** Actual independent checker owner. Reports preserve exact artifact and requirement bytes. */
export async function recordDailyCheckerFeedback({ build, profile, workspace, teamRunId, stageDir, item, versions }) {
  const load = name => import(pathToFileURL(path.join(build, "internal", `${name}.js`)).href);
  const [{ createFileCollaborationBoard }, { createCollaborationCheckerFeedbackV2 }, { methodBoardRoot }] = await Promise.all([
    load("integration/collaboration-learning/board-port"), load("integration/collaboration-learning/checker-feedback-v2"), load("surface/cli/learning-sink"),
  ]);
  const board = createFileCollaborationBoard(methodBoardRoot(profile, { TRYLO_HOME: profile }), () => true);
  const loaded = await board.load();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const facts = loaded.state.collaborationV2Facts ?? [];
  const parentEpisode = facts.filter(fact => fact.kind === "episode" && fact.source === "runtime"
    && fact.scope === workspace && fact.context.teamRunId === teamRunId && fact.context.memberId === "parent").at(-1);
  if (parentEpisode === undefined) return { ok: false, reason: "actual_parent_episode_missing" };

  const directory = path.join(stageDir, "independent-checker");
  mkdirSync(directory, { recursive: true });
  const reports = new Map(), checkerId = "independent-declarative-mapping-checker";
  const checkerVersion = hash(readFileSync(fileURLToPath(import.meta.url)));
  const requirements = { mapping: { sourceField: item.sourceField, targetField: item.targetField, scale: item.scale, raw: item.raw },
    count: { sourceField: "units", targetField: "count", scale: 1, raw: 3 },
    sourcePath: path.join(workspace, item.folder, "source.json"), checkerVersion };
  const requirementsPath = path.join(directory, "requirements.json");
  const requirementBytes = json({ ...requirements, sourceHash: hash(readFileSync(requirements.sourcePath)) });

  writeFileSync(requirementsPath, requirementBytes, { flag: "wx" });
  const requirementsDigest = hash(requirementBytes);
  const answered = new Set(facts.filter(fact => fact.kind === "event" && fact.action === "member_answered").map(fact => fact.factId));
  const unboundObservations = [];
  const artifacts = versions.flatMap((version, index) => {
    const next = versions.slice(index + 1).find(candidate => candidate.filename === version.filename);
    const memberId = version.filename === "mapping.json" ? "worker-a" : "worker-b";
    const episode = facts.filter(fact => fact.kind === "episode" && fact.source === "runtime" && fact.scope === workspace
      && fact.context.teamRunId === teamRunId && fact.context.memberId === memberId && fact.eventIds.some(id => answered.has(id))
      && Date.parse(fact.recordedAt) >= Date.parse(version.observedAt)
      && (next === undefined || Date.parse(fact.recordedAt) < Date.parse(next.observedAt)))
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];
    if (episode === undefined) {
      unboundObservations.push({ ...version, reason: "No completed member round uniquely binds this observed version" });
      return [];
    }

    return [{ artifactRef: path.join(stageDir, version.artifact), filename: version.filename, episode,
      observedAt: version.observedAt, observation: "immutable snapshot bound to an actual completed member round" }];
  });

  for (const filename of ["mapping.json", "count-mapping.json"]) {
    const artifactRef = path.join(workspace, item.folder, filename);
    if (existsSync(artifactRef)) artifacts.push({ artifactRef, filename, episode: parentEpisode, observation: "actual final delivery after CLI process exit" });
  }

  const feedback = createCollaborationCheckerFeedbackV2({ board, checker: { async read(runRef, expected) {
    const saved = reports.get(runRef);
    if (saved === undefined) return { ok: false, reason: "unknown_checker_run" };

    try {
      const bytes = readFileSync(saved.path), report = JSON.parse(bytes);
      if (hash(bytes) !== saved.hash || json(report.subject) !== json(expected)
        || hash(readFileSync(expected.artifactRef)) !== expected.contentHash
        || hash(readFileSync(requirementsPath)) !== expected.requirementsDigest
        || hash(readFileSync(requirements.sourcePath)) !== JSON.parse(requirementBytes).sourceHash) {
        return { ok: false, reason: "checker_inputs_changed" };
      }

      const checks = checkMapping(readFileSync(expected.artifactRef, "utf8"), saved.requirement);
      if (hash(json(checks)) !== report.receipt.checksDigest || checks.passed !== (report.receipt.verdict === "passed")) {
        return { ok: false, reason: "checker_reread_mismatch" };
      }

      return { ok: true, receipt: report.receipt };
    } catch { return { ok: false, reason: "checker_report_unavailable" }; }
  } } });
  const results = [];

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index], episode = artifact.episode, contentHash = hash(readFileSync(artifact.artifactRef));
    // All coordinates are copied from the actual runtime episode before checking.
    const subject = Object.freeze({ scope: workspace, teamRunId, taskId: episode.context.taskId,
      memberId: episode.context.memberId, round: episode.context.round, episodeId: episode.factId,
      artifactRef: artifact.artifactRef, contentHash, requirementsDigest,
      generatorId: `team:${teamRunId}:${episode.context.memberId}:${episode.context.taskId}` });
    const requirement = artifact.filename === "mapping.json" ? requirements.mapping : requirements.count;
    const checks = checkMapping(readFileSync(subject.artifactRef, "utf8"), requirement);
    const runRef = `${teamRunId}:check:${index + 1}:${contentHash.slice(0, 12)}`;
    const receipt = { schemaVersion: 2, runRef, subject, checkerId, checkerVersion,
      checksDigest: hash(json(checks)), verdict: checks.passed ? "passed" : "failed", recordedAt: new Date().toISOString() };
    const report = { subject, artifact, checks, receipt, checkerOwned: true, providerCalls: 0,
      limitation: "This validates exact artifact bytes and numeric requirements. It does not assign capability or prove a collaboration practice caused the outcome." };
    const reportPath = path.join(directory, `${index + 1}.json`), bytes = json(report) + "\n";

    writeFileSync(reportPath, bytes, { flag: "wx" });
    reports.set(runRef, { path: reportPath, hash: hash(bytes), requirement });
    results.push({ runRef, subject, checks, result: await feedback.record({ runRef, subject }) });
  }

  return { ok: true, parentEpisodeId: parentEpisode.factId, results, unboundObservations,
    nextLearning: "No manual invoke. The next ordinary task's automatic worker consumes these persisted checked facts." };
}
