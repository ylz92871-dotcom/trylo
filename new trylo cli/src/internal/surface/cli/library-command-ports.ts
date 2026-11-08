import type { ToolLibraryContext } from "../../tooling/library/index.js";
import type { ExpertCommand } from "../../subagent/experts/index.js";
import type { CentralLearningAllowance } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { InteractivePermissionIo } from "./permission.js";

/** Ordinary command transport only. Trusted UI gesture/executeUserAction never enters this port. */
export type CliLibraryCommandHosts = {
  readonly tool?: { execute(context: ToolLibraryContext, command: unknown, signal: AbortSignal): Promise<unknown> };
  readonly expert?: { execute(command: ExpertCommand, context?: { readonly signal?: AbortSignal }): Promise<unknown> };
  /** Explicit standalone allocation/resume only; ordinary library handlers never call this method. */
  readonly collaboration?: { run(allowance: CentralLearningAllowance | undefined, signal: AbortSignal): Promise<unknown> };
  readonly close?: () => Promise<void>;
};

export type CliLibraryHostFactory = (input: { readonly workspaceRoot: string; readonly signal: AbortSignal;
  readonly purpose?: "collaboration";
  /** Trusted host-to-host request channel, never parsed from a command payload. */
  readonly approval?: Pick<InteractivePermissionIo, "requestApproval" | "onApproval" | "supportsMemberApproval">;
}) => Promise<CliLibraryCommandHosts>;
