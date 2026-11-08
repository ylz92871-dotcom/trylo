import type { CheckExperience, CheckInput, CheckRequirements, CheckerVerdict } from "../domain/v2/contracts.js";
import type { LoopPorts } from "../../../../../loop/runner.js";
import type { JsonValue } from "../../../../../protocol/envelope.js";

export type CheckLearningAllowance = { readonly modelCalls: number; readonly executions: number; readonly tokens: number };

export type DailyCheckRun = { readonly runId: string; readonly versionId: string; readonly outcome:
  | { readonly kind: "checked"; readonly verdict: CheckerVerdict }
  | { readonly kind: "checker_error"; readonly code: string } | { readonly kind: "cancelled" } };

type OperationFailure = { readonly ok: false; readonly code: string; readonly message?: string };

type OperationResult = { readonly ok: true } | OperationFailure;

/** The domain owns all learning data. This port only lends facts and quota at the host boundary. */
export type DailyCheckRuntime = {
  capture(experience: CheckExperience): Promise<OperationResult>;
  check(input: { readonly scope: string; readonly requirements: CheckRequirements; readonly input: CheckInput;
    readonly runId: string; readonly sessionId: string; readonly turnId: string }, signal: AbortSignal): Promise<
      { readonly ok: true; readonly runs: readonly DailyCheckRun[] } | OperationFailure>;
  learn(dispatch: { readonly subsystem: "verifier"; readonly allowance: CheckLearningAllowance }, signal: AbortSignal): Promise<OperationResult>;
  feedback?(input: { readonly scope: string; readonly sessionId: string; readonly turnId: string; readonly sourceRef: string;
    readonly text: string; readonly runIds: readonly string[] }, signal: AbortSignal): Promise<OperationResult>;
};

/** Optional host composition, never a model-supplied field or a second loop contract. */
export type CheckLearningHost = {
  readonly collection: "enabled" | "disabled";
  readonly allowance: CheckLearningAllowance;
  readonly runtime?: DailyCheckRuntime;
};

export const DEFAULT_CHECK_ALLOWANCE: CheckLearningAllowance = { modelCalls: 1, executions: 0, tokens: 32768 };

export type CheckArtifactAccess = {
  read(paths: readonly string[], signal: AbortSignal): Promise<JsonValue | undefined>;
  same(first: string, second: string): boolean;
};

/** Canonical execution facts and lent services; no CLI configuration or terminal ownership. */
export type CheckTurnInput = {
  readonly scope: string; readonly sessionId: string; readonly turnId: string; readonly text: string;
  readonly requirements: CheckRequirements; readonly runtime: DailyCheckRuntime; readonly allowance: CheckLearningAllowance;
  readonly ports: LoopPorts; readonly signal: AbortSignal; readonly resumeTranscript?: readonly { readonly sequence: number }[]; readonly contextTokenLimit?: number;
  readonly artifacts: CheckArtifactAccess;
  readonly assess: (requirements: CheckRequirements, facts: CheckInput) => CheckExperience["assessment"];
  readonly warn: (code: string) => void; readonly publishResult: (message: string) => void; readonly beginLearning: () => void;
};
