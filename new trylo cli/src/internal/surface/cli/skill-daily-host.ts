import path from "node:path";
import { mkdirSync, appendFileSync } from "node:fs";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createFileVerificationRegistry } from "../../adapters/verification-authority-store/index.js";
import { createSkillExperienceFile } from "../../integration/skill-learning/experience-file.js";
import { createSkillLearningSubsystem } from "../../integration/skill-learning/runtime.js";
import { createSkillTaskModel } from "../../integration/skill-learning/model-task.js";
import { decodeLearnedSkillContent } from "../../integration/skill-learning/catalog.js";
import type { SkillModelUsage } from "../../integration/skill-learning/task-contract.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import type { TurnOutcome } from "./host.js";
import type { PermissionChoice } from "./permission-plan.js";
import { createSkillDailyManagement, skillDailyManagementPaths } from "./skill-daily-management.js";
import { skillDailyConnection, type SkillDailyExecutionOptions } from "./skill-daily-provider.js";
import { skillDailyChecks, qualifySkillTasks, type SkillDailyConfiguration } from "./skill-daily-checks.js";
import { runSkillDailyTrial } from "./skill-daily-trial.js";
import type { SkillLearningLearnReply } from "./skill-learning-command-contract.js";
import { sameSkillTaskFamily } from "../../learning/domains/skill/index.js";
import { skillDailyBoard } from "./skill-daily-board.js";
import { createSkillTaskQueue } from "../../integration/skill-learning/task-queue.js";
import { processSkillTaskIntake } from "./skill-daily-intake.js";
import { skillJournalUses, skillUseBeforeCheck } from "./skill-journal-usage.js";
import { createSkillDailyBudget } from "./skill-daily-budget.js";
import type { LearningGrantSnapshot } from "../../learning/control/grant-contract.js";

/** Shared ordinary-task and explicit command composition, with lazy provider construction. */
export function createSkillDailyHost(originalCtx: CliContext, scaffold?: RunScaffold, choice: PermissionChoice = {}, runtime: SkillDailyExecutionOptions = {}) {
  const ctx: CliContext = { ...originalCtx, cwd: scaffold?.workspaceRoot ?? originalCtx.cwd };
  const paths = skillDailyManagementPaths(ctx);
  const funding = createSkillDailyBudget(ctx, paths);
  let configuration: SkillDailyConfiguration | undefined;
  const config = () => configuration ??= skillDailyChecks(ctx, scaffold?.workspaceRoot ?? ctx.cwd);
  const history = createSkillExperienceFile({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled", retention: "segmented" });
  let connection: ReturnType<typeof skillDailyConnection> | undefined;
  const model = () => {
    connection ??= skillDailyConnection(ctx, scaffold, choice, funding.guard, runtime);
    return createSkillTaskModel({ provider: connection.provider, model: connection.model, collection: () => "enabled" });
  };
  let calls = 0, tokens = 0, outputTokens = 0, reported = true;
  let grantStatus: LearningGrantSnapshot["status"] | "unallocated" = "unallocated";
  let lifetime: AbortSignal | undefined;
  const refreshUsage = async () => {
    const usage = await funding.usage();
    calls = usage.calls;
    tokens = usage.tokens;
    outputTokens = usage.outputTokens;
    reported = usage.reported;
    grantStatus = usage.status;
    return usage;
  };
  const account = (usage: SkillModelUsage) => {
    calls += usage.calls;
    if (usage.usageStatus === "missing" && usage.calls > 0) reported = false;
    else {
      tokens += usage.totalTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
    }
  };
  const modelAllowance = (budget: { readonly maxTokens: number; readonly maxCalls: number }) => {
    const maxOutputTokens = Math.min(1500, Math.max(0, budget.maxTokens - outputTokens));
    return { maxModelCalls: grantStatus === "open" && reported && maxOutputTokens > 0 ? Math.min(1, Math.max(0, budget.maxCalls - calls)) : 0,
      maxInputBytes: 24_000, maxOutputTokens };
  };
  const allowance = () => modelAllowance(config().allowance);
  const log = (kind: string, payload: object) => {
    mkdirSync(paths.factsRoot, { recursive: true });
    appendFileSync(path.join(paths.factsRoot, "daily-events.ndjson"), `${JSON.stringify({ schemaVersion: 1, at: new Date(ctx.now()).toISOString(), kind, ...payload })}\n`, "utf8");
  };

  const learn = async (budget: { readonly maxTokens: number; readonly maxCalls: number }, signal: AbortSignal): Promise<SkillLearningLearnReply> => {
    lifetime = signal;
    const grantId = await funding.open(budget);

    await refreshUsage();
    const revision = grantId ?? "skill-no-model-grant";
    const intake = await processSkillTaskIntake({ ctx, workspaceId: paths.workspaceId, root: paths.factsRoot, revision, model, account, signal,
      maxTasks: Math.max(0, budget.maxCalls - calls),
      allowance: () => modelAllowance(budget),
      onExtracted: (entry, result) => log("extraction", { taskKey: entry.key, status: result.kind, usage: result.usage,
        ...(result.kind === "experience" ? { episodeId: result.experience.episode.id, derivation: result.derivation } : { reason: result.reason }) }) });

    await refreshUsage();

    if (signal.aborted) return { schemaVersion: 1, ok: true, result: { status: "cancelled", reason: "cancelled", ...(grantId === undefined ? {} : { grantId }), usage: { ...(reported ? { tokens } : {}), calls, usageStatus: reported ? "reported" : "missing" } } };

    const remainingCalls = Math.max(0, budget.maxCalls - calls), remainingTokens = Math.max(0, budget.maxTokens - outputTokens);
    const registry = createFileVerificationRegistry({ path: path.join(paths.factsRoot, "verification-receipts.ndjson"),
      clock: () => new Date(ctx.now()).toISOString(), idFactory: () => ctx.newId("skill-receipt") });
    const result = await createSkillLearningSubsystem({ board: skillDailyBoard(paths.boardRoot), authority: { verify: registry.verify },
      collection: () => "enabled", now: () => new Date(ctx.now()).toISOString(),

      opportunity: async () => {
        const read = history.read(ctx.newId("skill-opportunity"));
        if (!read.ok) throw new Error(read.code);
        return read.opportunity;
      },

      evaluate: request => {
        const permitted = choice.allowWrites === true && choice.allowTools?.includes("run_shell") === true
          && choice.allowTools.includes("skill") && !choice.denyTools?.some(name => name === "run_shell" || name === "skill");
        if (!permitted) return Promise.resolve({ kind: "waiting" as const, reason: "trial_execution_authorization_required" });

        connection ??= skillDailyConnection(ctx, scaffold, choice, funding.guard, runtime);

        return runSkillDailyTrial({ ctx, connection, registry, checks: config().checks, trialRoot: path.join(paths.factsRoot, "trials"),
          providerGuard: funding.guard,
          maxTokens: Math.max(0, budget.maxTokens - outputTokens), maxCalls: Math.max(0, budget.maxCalls - calls),

          onUsage: usage => { calls += usage.calls;
            if (usage.usageStatus === "missing") reported = false;
            else {
              tokens += usage.tokens ?? 0;
              outputTokens += usage.outputTokens ?? 0;
            } } }, request);
      },
    }).learn({ subsystem: "skill", allowance: { maxEpisodes: 256, maxInputBytes: 1_048_576,
      maxEvaluations: grantStatus === "open" && reported && remainingTokens >= 1000 && remainingCalls >= 6 ? 1 : 0, maxCycles: 4 } }, signal);

    await refreshUsage();
    log("learning", { result, intake, grantId, usage: { ...(reported ? { tokens } : {}), calls, usageStatus: reported ? "reported" : "missing" } });

    return { schemaVersion: 1 as const, ok: true as const, result: { ...result, ...(grantId === undefined ? {} : { grantId }), usage: { ...(reported ? { tokens, outputTokens } : {}), calls, usageStatus: reported ? "reported" as const : "missing" as const } } };
  };

  return {
    ...createSkillDailyManagement(ctx), learn,
    close: () => funding.close(lifetime?.aborted ? "cancelled" : "completed"),

    async prepareTask(text: string, signal: AbortSignal, identity?: { readonly sessionId: string; readonly turnId: string }) {
      lifetime = signal;

      if (signal.aborted) return undefined;

      await funding.open(config().allowance, identity === undefined ? undefined : `execution:${identity.sessionId}:${identity.turnId}`);
      await refreshUsage();
      let loaded = await createBoardReader(paths.boardRoot).load();
      if (!loaded.ok) throw new Error(loaded.reason);

      const prior = history.read("skill-correction-context");
      if (!prior.ok) throw new Error(prior.code);

      if (identity !== undefined && ctx.userSourceAvailable !== false && prior.opportunity.experiences.some(fact => fact.episode.outcome === "success") && !signal.aborted) {
        const interpreted = await model().interpretCorrection({ workspaceId: paths.workspaceId, currentUserText: text,
          priorEpisodes: prior.opportunity.experiences.map(fact => fact.episode) }, allowance(), signal);

        account(interpreted.usage);

        if (signal.aborted) return undefined;

        if (interpreted.kind === "correction" && text.includes(interpreted.quote)) {
          const correction = await model().extract({ workspaceId: paths.workspaceId, ...identity, taskText: text, transcript: [], events: [],
            qualification: { kind: "explicit_correction", ref: `user_explicit:${identity.sessionId}:${identity.turnId}`, outcome: "failure", correction: interpreted.correction },
            priorEpisodes: prior.opportunity.experiences.map(fact => fact.episode) }, allowance(), signal);

          account(correction.usage);

          if (signal.aborted) return undefined;

          if (correction.kind === "experience") {
            const saved = history.append(correction.experience);
            if (!saved.ok) throw new Error(saved.code);
            await learn({ maxTokens: 0, maxCalls: 0 }, signal);
            loaded = await createBoardReader(paths.boardRoot).load();
            if (!loaded.ok) throw new Error(loaded.reason);
          }
        }
      }

      const state = loaded.state;
      const candidates = state.assets.flatMap(asset => {
        const content = decodeLearnedSkillContent(asset.content);
        const live = state.activations.some(item => item.versionId === asset.versionId && (item.pointer === "shadow" || item.pointer === "active"));
        if (content?.workspaceId !== paths.workspaceId || !live) return [];
        return content.draft.variants.filter(variant => config().checks.some(check => sameSkillTaskFamily(check.taskFamily, variant.taskFamily)))
          .map(variant => ({ familyId: `${asset.versionId}/${variant.id}`, taskFamily: variant.taskFamily }));
      });
      if (candidates.length === 0 || signal.aborted) return undefined;

      // Current checker identity is observed at this task boundary. Candidate
      // language/repository conditions are never evidence about this new task.
      const firstCheck = config().checks[0];
      const sameConditions = config().checks.every(item => item.taskFamily.checkSchema === firstCheck?.taskFamily.checkSchema);
      const selected = await model().select({ workspaceId: paths.workspaceId, currentTaskText: text, candidates,
        ...(firstCheck === undefined || !sameConditions ? {} : { facts: { checkKind: firstCheck.taskFamily.checkKind,
          ...(firstCheck.taskFamily.checkSchema === undefined ? {} : { checkSchema: firstCheck.taskFamily.checkSchema }) } }) }, allowance(), signal);

      account(selected.usage);
      log("selection", { selectionKind: selected.kind, usage: selected.usage });

      if (selected.kind !== "selected") return undefined;

      return { state: loaded.state, context: { workspaceId: paths.workspaceId, taskFamily: selected.taskFamily } };
    },

    async finishTask(input: { readonly text: string; readonly sessionId: string; readonly turnId: string; readonly outcome: TurnOutcome;
      readonly events: readonly Envelope[]; readonly fromSequence: number }, signal: AbortSignal) {
      if (signal.aborted) return;

      const qualified = qualifySkillTasks(ctx, scaffold?.workspaceRoot ?? ctx.cwd, input.outcome.transcript, config().checks, input.fromSequence, input.events);
      const queue = createSkillTaskQueue({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled" });

      for (const task of qualified) {
        const board = await createBoardReader(paths.boardRoot).load();
        if (!board.ok) throw new Error(board.reason);

        const uses = skillJournalUses({ state: board.state, workspaceId: paths.workspaceId, contentRoot: ctx.cwd,
          sessionId: input.sessionId, turnId: input.turnId, transcript: input.outcome.transcript, events: input.events, fromSequence: input.fromSequence });
        const exposure = skillUseBeforeCheck(uses, board.state, task.check.taskFamily, task.sourceSequence);
        const sourceEvent = task.qualification.kind === "external_check" ? input.events.find(event => task.qualification.kind === "external_check"
          && task.qualification.checks.some(check => check.eventId === event.eventId)) : undefined;

        if (signal.aborted) break;

        const saved = queue.enqueue({ workspaceId: paths.workspaceId, sessionId: sourceEvent?.sessionId ?? input.sessionId, turnId: sourceEvent?.turnId ?? input.turnId, fromSequence: input.fromSequence,
          sourceSequence: task.sourceSequence, qualification: task.qualification, expectedFamily: task.check.taskFamily,
          checker: { id: task.check.id, command: task.check.command, verifierFiles: task.check.verifierFiles },
          ...(exposure === undefined ? {} : { usedSkill: { versionId: exposure.versionId, variantId: exposure.variantId, contentHash: exposure.contentHash } }) });
        if (!saved.ok) throw new Error(saved.code);
      }

      if (!signal.aborted) await learn(config().allowance, signal);
    },

    get checkInstructions() { return config().checks.length === 0 ? undefined : `For tasks covered by these independent checks, run the relevant check and preserve its verifier files:\n${config().checks.map(check => `${check.id}: ${check.command}`).join("\n")}`; },
  };
}
