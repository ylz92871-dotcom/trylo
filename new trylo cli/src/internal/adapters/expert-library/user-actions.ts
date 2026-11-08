import { randomUUID } from "node:crypto";
import { contentHashOf } from "../../learning/control/hash.js";
import { expertArchiveAuthorizationAction, expertRequestAuthorizationAction, parseExpertCommand, validateConfiguration, validateEdits } from "../../subagent/experts/index.js";
import { ExpertLibraryError } from "../../subagent/experts/contracts.js";
import type { ExpertActionContext, ExpertAuthorizationAction, ExpertCommand, ExpertLibrary } from "../../subagent/experts/index.js";

type LibraryRead = Pick<ExpertLibrary, "request" | "get">;

type TrustedContext = Omit<ExpertActionContext, "userActionId">;

export type ExpertUserActionInput = {
  readonly library: LibraryRead;
  readonly command: ExpertCommand;
  readonly context?: TrustedContext;
  readonly execute: (command: ExpertCommand, context: ExpertActionContext) => Promise<unknown>;
};

type ActionMatcher = (action: ExpertAuthorizationAction) => boolean;

type PendingGesture = { readonly matches: ActionMatcher; state: "available" | "consumed" };

/** In-flight evidence of an authenticated UI gesture, not a persistent authority.
 * Only the trusted host UI route may call executeUserAction. Never register it
 * as a model tool or infer a gesture from fields in an ordinary command. */
export function createExpertUserActionBridge(options: { readonly createId?: () => string } = {}) {
  const createId = options.createId ?? randomUUID;
  const pending = new Map<string, PendingGesture>();

  return {
    ownsUserAction: (actionId: string): boolean => pending.has(actionId),
    async consumeUserAction(actionId: string, action: ExpertAuthorizationAction): Promise<boolean> {
      const gesture = pending.get(actionId);
      if (gesture === undefined || gesture.state !== "available") return false;
      // A mismatched attempt also burns the evidence. An action token cannot be
      // probed repeatedly until another request happens to match it.
      gesture.state = "consumed";
      return gesture.matches(action);
    },
    async executeUserAction(input: ExpertUserActionInput): Promise<unknown> {
      const original = parseExpertCommand(structuredClone(input.command));
      const command = original.operation === "submit" || original.operation === "draft_revision"
        ? { ...original, requestId: original.requestId ?? createId() } : original;
      const context: TrustedContext = {
        ...(input.context?.signal === undefined ? {} : { signal: input.context.signal }),
        ...(input.context?.useScope === undefined ? {} : { useScope: structuredClone(input.context.useScope) }),
      };
      if (context.signal?.aborted) throw new ExpertLibraryError("cancelled", "Expert user action was cancelled");

      const matches = expectedAction(input.library, command, context);
      if (matches === undefined) return input.execute(command, context);

      if (pending.size >= 64) throw new ExpertLibraryError("invalid_state", "Too many expert user actions are awaiting completion");

      const actionId = createId();
      if (!actionId.trim() || actionId.length > 200 || pending.has(actionId)) throw new ExpertLibraryError("conflict", "Expert user action identity was reused");

      pending.set(actionId, { matches, state: "available" });

      try { return await input.execute(structuredClone(command), { ...context,
        ...(context.useScope === undefined ? {} : { useScope: structuredClone(context.useScope) }), userActionId: actionId }); }
      finally { pending.delete(actionId); }
    },
  };
}

function expectedAction(library: LibraryRead, command: ExpertCommand, context: TrustedContext): ActionMatcher | undefined {
  switch (command.operation) {
    case "submit": case "draft_revision": return creationMatcher(library, command, context);
    case "authorize_creation": return exact(expertRequestAuthorizationAction(library.request(command.requestId), "create"));
    case "edit": {
      const request = library.request(command.requestId);
      const configuration = validateConfiguration({ ...request.configuration, ...validateEdits(command.edits) });
      return exact(expertRequestAuthorizationAction({ ...request, configuration }, "edit"));
    }
    case "retain": return command.result.kind === "save" ? exact(expertRequestAuthorizationAction(library.request(command.requestId), "retain")) : undefined;
    case "archive": {
      const expert = library.get(command.expertId);
      if (expert === undefined) throw new ExpertLibraryError("not_found", "Expert is absent or archived");
      return exact(expertArchiveAuthorizationAction(expert));
    }
    default: return undefined;
  }
}

function creationMatcher(library: LibraryRead, command: Extract<ExpertCommand, { operation: "submit" | "draft_revision" }>, context: TrustedContext): ActionMatcher {
  const previous = command.expertId === undefined ? undefined : library.get(command.expertId);
  if (command.expertId !== undefined && previous === undefined) throw new ExpertLibraryError("not_found", "Expert is absent or archived");

  const priorEdits = previous === undefined ? {} : library.request(previous.requestId).userEdits;

  return action => {
    if (action.requestId !== command.requestId || action.stage !== "create") return false;

    const request = library.request(action.requestId);
    if (request.state !== "awaiting_creation" || request.revision !== 0 || request.creationAuthorization !== undefined
      || request.baseVersion !== (previous?.version ?? 0) || previous !== undefined && request.expertId !== previous.expertId
      || request.experienceKey !== (previous?.experienceKey ?? `expert:${request.expertId}`)
      || !same(request.configuration, previous?.configuration) || !same(request.userEdits, priorEdits)
      || !same(request.useScope, context.useScope)) return false;

    if (command.operation === "submit") {
      if (request.origin !== command.origin || request.instruction !== command.instruction
        || !same(request.association, command.association) || (request.preparation ?? "build") !== "build") return false;
    } else if (request.origin !== "settings" || request.preparation !== "reuse_configuration" || request.association !== undefined) return false;

    return exact(expertRequestAuthorizationAction(request, "create"))(action);
  };
}

function exact(expected: ExpertAuthorizationAction): ActionMatcher {
  return action => same(expected, action);
}

function same(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined ? left === right : contentHashOf(left) === contentHashOf(right);
}
