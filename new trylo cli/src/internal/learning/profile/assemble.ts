import type { ReasonCode } from "../control/reasons.js";
import type { ExecutionProfileSnapshot } from "../../contract/profile.js";
import { emptySnapshot, resolveProfile } from "./resolver.js";
import type { BoardState } from "../control/state.js";

export type ContextMessage = {
  readonly role: string;
  readonly content: string;
};

export type TurnInput = {
  readonly messages?: ReadonlyArray<ContextMessage>;
  readonly signal?: AbortSignal;
};

export type AssembledSystemFragment = {
  readonly id: string;
  readonly body: string;
  readonly origin: string;
  readonly scope: string;
  readonly version: number;
};

export type DegradedReason = {
  readonly code: ReasonCode;
  readonly message: string;
};

export type AssembledLearningContext = {
  readonly messages: ReadonlyArray<ContextMessage>;
  readonly systemFragments: ReadonlyArray<AssembledSystemFragment>;
  readonly requiredChecks: readonly [];
  readonly verified: false;
  readonly profileSnapshot: ExecutionProfileSnapshot;
  readonly degradedReason?: DegradedReason;
};

export function assembleFromState(
  state: BoardState,
  turnInput: TurnInput,
  lastKnownGood?: ExecutionProfileSnapshot,
): AssembledLearningContext {
  const messages = turnInput.messages ?? [];

  if (turnInput.signal?.aborted) {
    return degrade(messages, lastKnownGood, "learning_timeout", "assemble aborted");
  }

  const instruction = messages.find((item) => item.role === "user")?.content;
  const snapshot = resolveProfile(state, {
    scope: "user",
    ...(instruction !== undefined ? { currentInstruction: instruction } : {}),
  });

  return {
    messages,
    systemFragments: fragmentsFrom(snapshot),
    requiredChecks: [],
    verified: false,
    profileSnapshot: snapshot,
  };
}

export function assembleDegraded(
  turnInput: TurnInput,
  lastKnownGood: ExecutionProfileSnapshot | undefined,
  code: ReasonCode,
  message: string,
): AssembledLearningContext {
  return degrade(turnInput.messages ?? [], lastKnownGood, code, message);
}

function degrade(
  messages: ReadonlyArray<ContextMessage>,
  lastKnownGood: ExecutionProfileSnapshot | undefined,
  code: ReasonCode,
  message: string,
): AssembledLearningContext {
  // Preserve the caller's messages even when learning context is unavailable.
  const mode = lastKnownGood === undefined ? "no_learning" as const : "last_known_good" as const;
  const used: ExecutionProfileSnapshot =
    lastKnownGood === undefined
      ? emptySnapshot("user", 0, "no_learning", [{ code, message }])
      : { ...lastKnownGood, learningMode: mode, diagnostics: [{ code, message }] };

  return {
    messages,
    systemFragments: mode === "last_known_good" ? fragmentsFrom(used) : [],
    requiredChecks: [],
    verified: false,
    profileSnapshot: used,
    degradedReason: { code, message },
  };
}

function fragmentsFrom(
  snapshot: ExecutionProfileSnapshot,
): ReadonlyArray<AssembledSystemFragment> {
  return snapshot.userRules.map((rule) => ({
    id: rule.versionId,
    body: rule.text,
    origin: "user-stated",
    scope: rule.scope,
    version: 1,
  }));
}
