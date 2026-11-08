import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileVerificationRegistry } from "../../adapters/verification-authority-store/index.js";
import { createSkillCatalog } from "../../adapters/skills/catalog.js";
import { evaluateCandidate } from "../../evaluation/evaluator.js";
import { renderSkillVariantMarkdown, sameSkillTaskFamily, skillTaskFamilyKey, type SkillVariant } from "../../learning/domains/skill/index.js";
import type { SkillTrialRequest, SkillTrialResult } from "../../integration/skill-learning/runtime-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CliContext } from "./context.js";
import { executeTurn, isTurnFailure } from "./host.js";
import { permissionFor } from "./permission-for-run.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { qualifySkillTasks, workspaceFile, type SkillDailyCheck } from "./skill-daily-checks.js";
import type { SkillDailyConnection } from "./skill-daily-provider.js";
import type { ExternalVerdict } from "../../learning/domains/shared/types.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { Envelope } from "../../protocol/envelope.js";
import { replayFileDigest, replayInputsUnchanged } from "./skill-daily-trial-files.js";

type TrialInput = {
  readonly ctx: CliContext; readonly connection: SkillDailyConnection; readonly registry: FileVerificationRegistry;
  readonly checks: readonly SkillDailyCheck[]; readonly trialRoot: string; readonly maxTokens: number; readonly maxCalls: number;
  readonly providerGuard?: (provider: ProviderPort) => ProviderPort;
  readonly onUsage?: (usage: { readonly tokens?: number; readonly outputTokens?: number; readonly calls: number; readonly usageStatus: "reported" | "missing" }) => void;
};

export async function runSkillDailyTrial(input: TrialInput, request: SkillTrialRequest): Promise<SkillTrialResult> {
  // The catalog fields the first path under each exact condition. Every such
  // condition must be tested; a pass for one cannot expose untested branches.
  const seenFamilies = new Set<string>();
  const fieldable = request.content.draft.variants.filter(variant => {
    const key = skillTaskFamilyKey(variant.taskFamily);
    if (seenFamilies.has(key)) return false;
    seenFamilies.add(key);
    return true;
  });
  const sampleCount = fieldable.length * 2;
  if (sampleCount === 0 || input.maxCalls < sampleCount * 3 || input.maxTokens < sampleCount * 500) return { kind: "waiting", reason: "independent_replay_allowance_required" };

  if (fieldable.some(variant => !input.checks.some(check => check.replay !== undefined && sameSkillTaskFamily(check.taskFamily, variant.taskFamily)))) {
    return { kind: "waiting", reason: "condition_replay_fixture_required" };
  }

  const samples: ExternalVerdict[] = [];

  for (const variant of fieldable) {
    for (let index = 0; index < 2; index += 1) {
      const result = await runSkillDailySample(input, request, variant, sampleCount);
      if (result.kind === "waiting") return result;
      samples.push(result.anchor);
    }
  }

  const issued = await input.registry.issue({ domain: "user_explicit", subject: { subjectKind: "content_candidate", subjectId: request.content.draft.id,
    subjectVersion: request.versionId, scope: request.scope }, verifierId: "skill-independent-execution", generatorId: "skill_inducer",
    issuedAt: new Date(input.ctx.now()).toISOString(), sourceFactRef: `execution:skill-trials:${contentHashOf(samples)}` });
  if (!issued.ok) return { kind: "waiting", reason: issued.code };

  return { kind: "evidence", receiptRef: issued.receipt.receiptId, evidence: evaluateCandidate({ proposalId: request.content.draft.id,
    baselineRef: request.baselineVersionId ?? "baseline:observed-failures", candidateRef: request.versionId,
    generatorRoleId: "skill_inducer", evaluatorRoleId: "skill-independent-execution",
    baselineAnchors: [{ kind: "test", result: "fail", ref: request.content.draft.negativeExamples[0]?.episodeId ?? "observed-failure", selfGenerated: false }],
    candidateAnchors: samples, weakSignals: [], costDelta: 0, latencyDelta: 0, outputLengthDelta: 0,
    criticalRegressionFailed: false, failureDiversity: request.content.draft.negativeExamples.length, sampleSize: samples.length }) };
}

/** Isolated real execution, under the original runtime's Permission Service. */
async function runSkillDailySample(input: TrialInput, request: SkillTrialRequest, variant: SkillVariant, sampleCount: number): Promise<{ readonly kind: "sample"; readonly anchor: ExternalVerdict } | Extract<SkillTrialResult, { kind: "waiting" }>> {
  const check = input.checks.find(item => sameSkillTaskFamily(item.taskFamily, variant.taskFamily));
  if (check?.replay === undefined) return { kind: "waiting", reason: "independent_replay_fixture_required" };

  if (request.signal.aborted) return { kind: "waiting", reason: "cancelled" };

  const root = path.join(input.trialRoot, request.versionId.replace(/[^A-Za-z0-9_-]/g, "_"), input.ctx.newId("trial"));
  const workspace = path.join(root, "workspace");

  await mkdir(workspace, { recursive: true });
  let bytes = 0;
  const initialHashes: Record<string, string> = {};
  const actualRoot = await realpath(input.ctx.cwd);

  for (const relative of new Set([...check.replay.files, ...Object.keys(check.verifierFiles)])) {
    const source = await realpath(workspaceFile(input.ctx.cwd, relative));
    const sourceRelative = path.relative(actualRoot, source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) return { kind: "waiting", reason: "replay_fixture_outside_workspace" };

    const content = await readFile(source);

    bytes += content.byteLength;

    if (bytes > 1_048_576) return { kind: "waiting", reason: "replay_fixture_exceeds_allowance" };

    const destination = workspaceFile(workspace, relative);

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
    initialHashes[relative] = replayFileDigest(content);
  }

  const name = "learning-candidate-trial";
  const body = renderSkillVariantMarkdown(request.content.draft, variant);
  const skills = createSkillCatalog([{ name, description: "Explicit isolated candidate trial", source: "additional", skillRoot: workspace, path: workspace,
    contentHash: contentHashOf(request.content), body, userInvocable: true, disableModelInvocation: false, forkExecution: false }]);
  const connection = input.connection;
  const execution = createRunExecution(workspace, { homeDir: input.ctx.homeDir, env: input.ctx.env,
    ...(connection.shellIsolation === undefined ? {} : { shellIsolation: connection.shellIsolation }),
    ...(input.ctx.platform === undefined ? {} : { platform: input.ctx.platform as NodeJS.Platform }) });
  const calls = new Set<string>();
  const checkEvents: Envelope[] = [];
  let streamReported = false, missingReport = false;
  let accounted = false;

  try {
    const outcome = await executeTurn({ text: `${check.replay.task}\nFirst call skill '${name}' and apply its procedure. Then run the independent check exactly: ${check.command}. Do not modify verifier files.`,
      sessionId: input.ctx.newId("skill-trial-session"), turnId: input.ctx.newId("skill-trial-turn"), correlationId: input.ctx.newId("skill-trial"),
      workspaceRoot: workspace, workspaceId: request.content.workspaceId, checkpointRoot: path.join(root, "checkpoints"),
      providerId: connection.providerId, providerKind: connection.providerKind, model: connection.model, endpoint: connection.endpoint, apiKey: connection.apiKey,
      ...(connection.tokenManager === undefined ? {} : { tokenManager: connection.tokenManager }),
      permission: permissionFor(input.ctx.stdinIsTty ? "interactive" : "non_interactive", input.ctx, connection.permissionChoice, workspace),
      format: "stream-json", sink: { stdout: () => {}, stderr: () => {} }, now: input.ctx.now, cancelSignal: request.signal,

      onRunEnvelope: event => {
        if (event.kind === "tool_result" && checkEvents.length < 4096) checkEvents.push(event);
        if (event.kind === "api_call") {
          if (calls.size > 0 && !streamReported) missingReport = true;
          calls.add(event.eventId);
          streamReported = false;
        }
        if (event.kind === "usage" && calls.size > 0) streamReported = true;
      },

      systemPrompt: { mode: "replace", text: "You are executing an explicitly budgeted isolated skill trial. Follow the user's task, load the offered skill, preserve the independent checker, and run it. Use only mounted tools and respect every permission refusal. Do not claim success without the checker." },
      ...(input.providerGuard === undefined ? {} : { providerGuard: input.providerGuard }),
      execution, skills, maxIterations: Math.floor(input.maxCalls / sampleCount), maxTokens: Math.floor(input.maxTokens / sampleCount) });
    const inputsUnchanged = await replayInputsUnchanged(workspace, initialHashes);

    if (isTurnFailure(outcome)) {
      accounted = true;
      input.onUsage?.({ calls: calls.size, usageStatus: "missing" });
      const reason = inputsUnchanged ? "trial_execution_unavailable" : "replay_fixture_changed";
      await writeFile(path.join(root, "failure.json"), JSON.stringify({ reason, calls: calls.size, exitCode: outcome.exitCode, initialHashes }));
      return { kind: "waiting", reason };
    }

    const usageStatus = calls.size > 0 && !missingReport && streamReported ? "reported" : "missing";

    accounted = true;
    input.onUsage?.({ calls: calls.size, usageStatus,
      ...(usageStatus === "missing" ? {} : { tokens: outcome.result.usage.totalTokens, outputTokens: outcome.result.usage.outputTokens }) });

    if (!inputsUnchanged) {
      await writeFile(path.join(root, "failure.json"), JSON.stringify({ reason: "replay_fixture_changed", calls: calls.size, initialHashes, usageStatus }));
      return { kind: "waiting", reason: "replay_fixture_changed" };
    }

    if (usageStatus === "missing") return { kind: "waiting", reason: "trial_usage_unreported" };

    await writeFile(path.join(root, "execution.json"), JSON.stringify({ result: outcome.result, transcript: outcome.transcript.filter(item => item.kind !== "assistant_reasoning" && item.kind !== "system") }, null, 2));
    const qualified = qualifySkillTasks({ readFile: file => input.ctx.readFile(file) }, workspace, outcome.transcript, [check], 0, checkEvents);
    const adopted = outcome.transcript.some(item => item.kind === "tool_call" && item.name === "skill" && item.arguments.skill === name)
      && outcome.transcript.some(item => item.kind === "tool_result" && item.name === "skill" && item.outcome === "succeeded");
    const passed = qualified.some(item => item.qualification.outcome === "success") && adopted;

    await writeFile(path.join(root, "check.json"), JSON.stringify({ candidateVersion: request.versionId, adopted, passed,
      checkerId: check.id, sourceSequences: qualified.map(item => item.sourceSequence), usage: outcome.result.usage }, null, 2));

    if (!passed) return { kind: "waiting", reason: "independent_replay_failed" };

    return { kind: "sample", anchor: { kind: "test", result: "pass", ref: `execution:skill-trial:${variant.id}:${root}`, selfGenerated: false } };
  } finally {
    if (!accounted) input.onUsage?.({ calls: calls.size, usageStatus: "missing" });
    await execution.close();
  }
}
