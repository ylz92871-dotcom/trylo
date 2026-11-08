import type { WorkflowImprovementRuntimeOptions, WorkflowImprovementStorePort, WorkflowImprovementFundingPort } from "../runtime/improvement-contracts.js";
import { createWorkflowImprovementRuntime } from "../runtime/improvement-runtime.js";
import { commitWorkflowImprovementRecord, commitWorkflowImprovementRevision, commitWorkflowImprovementUse, readWorkflowImprovements } from "./improvement-board.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";
import { commitWorkflowResearchCheckpoint } from "./research-board.js";

export type FileWorkflowImprovementOptions = Omit<WorkflowImprovementRuntimeOptions, "store" | "funding"> & { readonly boardRoot: string };

/** The one file-backed composition; the core owns policy and never imports storage adapters. */
export function fileWorkflowImprovementPorts(options: Pick<FileWorkflowImprovementOptions, "boardRoot" | "scope" | "centralScope" | "budgetId" | "allowance" | "now">): {
  readonly store: WorkflowImprovementStorePort; readonly funding: WorkflowImprovementFundingPort;
} {
  return { funding: createWorkflowImprovementFunding({ ...options, research: true }), store: {
    read: () => readWorkflowImprovements(options.boardRoot, options.scope, options.centralScope),
    save: (content, issuedAt, signal) => commitWorkflowImprovementRecord(options.boardRoot, content, issuedAt, signal),
    adopt: (record, issuedAt, signal, policy) => commitWorkflowImprovementUse(options.boardRoot, record, issuedAt, signal, policy, options.centralScope),
    publish: (artifact, issuedAt, owner) => commitWorkflowImprovementRevision(options.boardRoot, artifact, issuedAt,
      { ...owner, ...(options.centralScope === undefined ? {} : { centralScope: options.centralScope }) }),
    saveResearch: (checkpoint, owner) => commitWorkflowResearchCheckpoint(options.boardRoot, checkpoint,
      { ...owner, ...(options.centralScope === undefined ? {} : { centralScope: options.centralScope }) }),
  } };
}

export function createFileWorkflowImprovementRuntime(options: FileWorkflowImprovementOptions) {
  return createWorkflowImprovementRuntime({ ...options, ...fileWorkflowImprovementPorts(options) });
}
