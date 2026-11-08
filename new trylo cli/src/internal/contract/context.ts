import type { Message } from "./execution.js";
import { EMPTY_PROFILE, type ExecutionProfileSnapshot, type ProfilePort } from "./profile.js";

export type ExecutionContext = {
  readonly messages: ReadonlyArray<Message>;
  readonly profile: ExecutionProfileSnapshot;
  readonly degraded: boolean;
  readonly degradedReason?: string;
};

export type ExecutionContextPort = {
  assemble(input: {
    readonly taskId: string;
    readonly messages: ReadonlyArray<Message>;
    readonly signal?: AbortSignal;
  }): Promise<ExecutionContext>;
};

export function contextFromProfile(profile: ProfilePort): ExecutionContextPort {
  return {
    async assemble(input) {
      try {
        const snapshot = await profile.load(input.taskId);
        const degraded = snapshot.learningMode !== "full";
        const degradedReason = degraded ? snapshot.diagnostics[0]?.message : undefined;

        return {
          messages: composeMessages(snapshot, input.messages),
          profile: snapshot,
          degraded,
          ...(degradedReason !== undefined ? { degradedReason } : {}),
        };
      } catch (err) {
        const degradedReason = err instanceof Error ? err.message : "profile_unavailable";
        return {
          messages: input.messages,
          profile: EMPTY_PROFILE,
          degraded: true,
          degradedReason,
        };
      }
    },
  };
}

function composeMessages(
  snapshot: ExecutionProfileSnapshot,
  callerMessages: ReadonlyArray<Message>,
): ReadonlyArray<Message> {
  const learned = [
    ...snapshot.promptPatches.map((rule) => `prompt_patch:${rule.versionId}:${rule.text}`),
    ...snapshot.userRules.map((rule) => `user_rule:${rule.versionId}:${rule.text}`),
  ];
  if (learned.length === 0) {
    return callerMessages;
  }

  const profileMessage: Message = {
    role: "system",
    content: [
      `Trylo learned profile ${snapshot.snapshotId}.`,
      "These historical hints are lower priority than the current user instruction.",
      ...learned,
    ].join("\n"),
  };

  return [profileMessage, ...callerMessages];
}
