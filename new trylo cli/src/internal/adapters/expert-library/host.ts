import type { PermissionPort } from "../../ports/permission.js";
import type { ProviderPort, ProviderUsage } from "../../ports/provider.js";
import type { ToolLibrary, ToolLibraryContext } from "../../tooling/library/index.js";
import { createExpertBuilder, ExpertLibrary, ExpertLibraryError, executeExpertCommand, instantiateExpertFromLibrary } from "../../subagent/experts/index.js";
import type { ExpertSelection, InstantiateExpertInput, ExpertExperiencePort, ExpertCommand, ExpertActionContext } from "../../subagent/experts/index.js";
import { createFileExpertStore } from "./store.js";
import { createPermissionExpertAuthorization } from "./permission.js";
import type { PermissionExpertAuthorizationOptions } from "./permission.js";
import { createProviderExpertSynthesis } from "./provider.js";
import type { ExpertUsageContext } from "./provider.js";
import { createToolExpertResources } from "./resources.js";
import type { ExpertResourceOptions } from "./resources.js";
import { createToolLibraryExpertPort } from "./tool-port.js";
import { createExpertUserActionBridge } from "./user-actions.js";

export type ExpertHostOptions = ExpertResourceOptions & {
  /** Host uses its existing account root formula; expert library owns no alternate home convention. */
  readonly rootDir: string; readonly permission: PermissionPort; readonly provider: ProviderPort;
  readonly model: string; readonly maxOutputTokens: number; readonly maxPromptChars?: number;
  readonly onUsage?: (usage: ProviderUsage, context: ExpertUsageContext) => void;
  readonly consumeUserAction?: PermissionExpertAuthorizationOptions["consumeUserAction"];
  readonly toolLibrary?: ToolLibrary; readonly experience?: ExpertExperiencePort;
};

/** Production composition adapter for shared CLI/Desktop/Personal Agent assembly. No stub dependencies. */
export function createExpertLibraryHost(options: ExpertHostOptions) {
  const gestures = createExpertUserActionBridge();
  const authorization = createPermissionExpertAuthorization({ permission: options.permission,
    consumeUserAction: async (id, action) => gestures.ownsUserAction(id)
      ? gestures.consumeUserAction(id, action) : (options.consumeUserAction?.(id, action) ?? false) });
  const library = new ExpertLibrary({ store: createFileExpertStore(options.rootDir), authorization,
    builder: createExpertBuilder({ resources: createToolExpertResources(options),
      ...(options.experience === undefined ? {} : { experience: options.experience }),
      synthesize: createProviderExpertSynthesis({ provider: options.provider, model: options.model, maxOutputTokens: options.maxOutputTokens,
        ...(options.maxPromptChars === undefined ? {} : { maxPromptChars: options.maxPromptChars }),
        ...(options.onUsage === undefined ? {} : { onUsage: options.onUsage }) }) }) });

  return {
    library,
    execute: (command: ExpertCommand, context?: Parameters<typeof executeExpertCommand>[2]) => executeExpertCommand(library, command, context),
    /** Authenticated UI events only. Never expose this route as a model tool. */
    executeUserAction: (command: ExpertCommand, context: Omit<ExpertActionContext, "userActionId"> = {}) => gestures.executeUserAction({
      library, command, context, execute: (canonical, actionContext) => executeExpertCommand(library, canonical, actionContext) }),
    instantiate(selection: ExpertSelection, input: Omit<InstantiateExpertInput, "expert" | "tools" | "skills" | "experience"> & { readonly toolContext: ToolLibraryContext }) {
      if (input.toolContext.memberId !== input.memberId || input.useScope !== undefined && input.toolContext.scope !== input.useScope.workspaceId) {
        throw new ExpertLibraryError("invalid_input", "Expert dispatch and tool context must identify the same member and workspace");
      }
      return instantiateExpertFromLibrary(library, selection, { ...input,
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        ...(options.experience === undefined ? {} : { experience: options.experience }),
        ...(options.toolLibrary === undefined ? {} : { tools: createToolLibraryExpertPort(options.toolLibrary, input.toolContext) }) });
    },
  };
}
