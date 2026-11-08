import path from "node:path";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createCentralCollaborationExecution } from "../../integration/central-learning/collaboration.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import { collaborationSourceCondition } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { createPersonalAgentRuntime, type PersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createDenyAllPermission } from "./permission.js";

export type CentralRuntimeCollaborationOptions = {
  readonly ctx: CliContext;
  readonly boardRoot: string;
  /** Canonical workspace root, shared with the central scope owner. */
  readonly scope: string;
  readonly provider: ProviderPort;
  readonly model: string;
  readonly modelRef: string;
  readonly maxOutputTokens?: number;
  readonly contextForIssue?: CentralLearningContextReader;
  readonly enabled: () => boolean;
};

export type CentralRuntimeCollaboration = {
  readonly port: CentralLearningExecutionPort;
  readonly control: PersonalAgentRuntime["control"];
  close(): Promise<void>;
};

/** Borrow the existing collaboration worker and its original libraries without
 * mounting a production task, team, PA tools or a second funding path. */
export function createCentralRuntimeCollaboration(options: CentralRuntimeCollaborationOptions): CentralRuntimeCollaboration {
  const { ctx } = options;

  if (path.resolve(options.boardRoot) !== path.resolve(methodBoardRoot(ctx.homeDir, ctx.env))) {
    throw new Error("central_collaboration_board_root_mismatch");
  }

  let open = true;
  const enabled = () => open && options.enabled();
  const tools: ToolPort = {
    snapshot: () => [],
    execute: async (_call, signal) => signal.aborted ? { outcome: "cancelled" }
      : { outcome: "error", code: "tool_unavailable", message: "The independent learning host has no business tools mounted" },
    cancel: async () => {},
  };
  const runtime = createPersonalAgentRuntime({
    homeDir: ctx.homeDir, env: ctx.env, scope: options.scope,
    // This identifies composition only. It is never captured as a business
    // turn, member report or frozen source-team configuration.
    turnId: ctx.newId("central-collaboration-runtime"), now: ctx.now,
    newOwnerId: () => ctx.newId("central-collaboration-owner"),
    warn: reason => ctx.stderr(`warning: ${reason}\n`),
    provider: options.provider, learningProvider: options.provider, model: options.model,
    ...(options.maxOutputTokens === undefined ? {} : { learningMaxOutputTokens: options.maxOutputTokens }),
    tools, workspaceTools: tools, toolSelectionCeiling: [],
    permission: createDenyAllPermission(), grants: createPermissionGrantCache(),
    sandbox: createWorkspaceSandbox({ workspaceRoot: options.scope, mode: "deny_all" }),
  });
  const port = createCentralCollaborationExecution({
    boardRoot: options.boardRoot, scope: options.scope, enabled, control: runtime.control,
    admitSource: runtime.admitLearningSource,
    // Historical reports survive their task. No current team is mounted here,
    // so the original projection keeps its structure and purpose unknown.
    sourceCondition: issue => collaborationSourceCondition(issue), modelRef: options.modelRef,
    ...(options.contextForIssue === undefined ? {} : { contextForIssue: options.contextForIssue }),
  });

  return { port, control: runtime.control, async close() {
    open = false;
    await runtime.close();
  } };
}
