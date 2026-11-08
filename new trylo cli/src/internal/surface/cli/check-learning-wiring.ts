import { createCheckTurn, requirementsForCheckTask, DEFAULT_CHECK_ALLOWANCE, createCheckArtifactAccess,
  type CheckExperience, type CheckInput, type CheckRequirements, type DailyCheckRuntime } from "../../learning/agent/subsystems/check/index.js";
import { isLearningSwitch, switchEnablesCheck } from "../../integration/user-learning/index.js";
import type { CliStreamEvent } from "../../protocol/cli-stream.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring } from "./wiring.js";
import { finishTurn, type TurnFinishInput } from "./turn-finish.js";
import { createDailyCheckRuntime, assessDailyCheckInput } from "./check-learning-runtime.js";

export type { CheckLearningAllowance, DailyCheckRun, DailyCheckRuntime, CheckLearningHost } from "../../learning/agent/subsystems/check/index.js";

export type CheckLearningDependencies = {
  readonly createRuntime?: (input: TurnHostInput, wiring: Wiring) => Promise<DailyCheckRuntime | undefined>;
  readonly assess?: (requirements: CheckRequirements, facts: CheckInput) => CheckExperience["assessment"];
};

/** The host owns opt-in, terminal projection and composition; check owns scheduling and captured facts. */
export async function createCheckLearningForTurn(input: TurnHostInput, wiring: Wiring, deps: CheckLearningDependencies = {}) {
  const enabled = input.checkLearning !== undefined ? input.checkLearning.collection === "enabled"
    : isLearningSwitch(input.learning?.switch) && switchEnablesCheck(input.learning.switch);
  if (!enabled || input.text.trim() === "/compact") return undefined;

  const warned = new Set<string>();
  let phase: "execution" | "learning" = "execution";
  const warn = (code: string): void => {
    if (warned.has(code)) return;
    warned.add(code);
    publish(input, "check_learning_degraded", code, phase === "learning");
  };

  if (input.userSourceAvailable === false) {
    warn("user_source_unavailable");
    return undefined;
  }

  const requirements = requirementsForCheckTurn(input);
  if (!requirements.ok) {
    warn(requirements.code);
    return undefined;
  }

  let runtime: DailyCheckRuntime | undefined;

  try { runtime = input.checkLearning?.runtime ?? await (deps.createRuntime ?? createDailyCheckRuntime)(input, wiring); }
  catch {
    warn("runtime_unavailable");
    return undefined;
  }

  if (runtime === undefined) {
    warn("runtime_unavailable");
    return undefined;
  }

  return createCheckTurn({ scope: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId, text: input.text,
    requirements: requirements.value, runtime, ports: wiring.ports, allowance: input.checkLearning?.allowance ?? DEFAULT_CHECK_ALLOWANCE,
    signal: input.cancelSignal ?? new AbortController().signal,
    ...(input.contextTokenLimit === undefined ? {} : { contextTokenLimit: input.contextTokenLimit }),
    ...(input.resumeTranscript === undefined ? {} : { resumeTranscript: input.resumeTranscript }),
    assess: deps.assess ?? assessDailyCheckInput,
    artifacts: createCheckArtifactAccess({ workspaceRoot: input.workspaceRoot, permission: input.permission,
      tools: wiring.ports.tools, grants: wiring.ports.grants, warn }),
    warn, publishResult: message => publish(input, "check_learning_result", message),
    beginLearning: () => { phase = "learning"; } });
}

export type CheckLearningTurn = NonNullable<Awaited<ReturnType<typeof createCheckLearningForTurn>>>;

/** Checking finishes before the one authoritative CLI result is projected. */
export async function finishCheckLearningTurn(finish: TurnFinishInput, checks: CheckLearningTurn | undefined) {
  await checks?.finish(finish.result);
  return finishTurn(finish);
}

/** Learning starts after execution resources close; a learner never borrows a still-running tool state machine. */
export async function closeCheckLearningTurn(state: { readonly reward: { flush(): Promise<void> } | undefined;
  readonly input: Pick<TurnHostInput, "bindAgentTools">; readonly wiring: Pick<Wiring, "close">;
  readonly toolGap: { close(): Promise<void> } | undefined; readonly checks: CheckLearningTurn | undefined }) {
  await state.reward?.flush();
  state.input.bindAgentTools?.(undefined);
  await state.wiring.close();
  await state.toolGap?.close();
  await state.checks?.afterClose();
}

/** Project only host context; freezing the actual acceptance standard belongs to check. */
export function requirementsForCheckTurn(input: Pick<TurnHostInput, "text" | "responseSchema" | "projectContext">) {
  return requirementsForCheckTask({ text: input.text,
    ...(input.responseSchema === undefined ? {} : { responseSchema: input.responseSchema }),
    ...(input.projectContext === undefined ? {} : { projectMessages: input.projectContext.messages }) });
}

function publish(input: Pick<TurnHostInput, "format" | "sink">, code: string, message: string, postTerminal = false): void {
  // These are projections of the persisted checker runtime result, not fabricated Execution Loop verdicts.
  const event: CliStreamEvent = { type: "warning", code, message };
  if (input.format === "stream-json" && !postTerminal) input.sink.stdout(`${JSON.stringify(event)}\n`);
  else input.sink.stderr(`${code}: ${message}\n`);
}
