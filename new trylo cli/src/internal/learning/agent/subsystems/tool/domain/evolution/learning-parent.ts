import type { ToolRuntimeDescriptor } from "../../../../../../tooling/contract/descriptor.js";
import type { ToolEvolutionRequest } from "./contracts.js";
import type { NpmToolRuntime } from "./npm-production-plan.js";

/** A planning view pins the production version without copying the installation tree into a prompt.
 * Source inspection and adaptation load that exact version through the production owner. */
export type ToolLearningNpmParent = {
  readonly versionId: string;
  readonly contentHash: string;
  readonly capability: string;
  readonly descriptor: ToolRuntimeDescriptor;
  readonly runtime: NpmToolRuntime;
  readonly checks: ToolEvolutionRequest;
  readonly installationId: string;
  readonly package: { readonly name: string; readonly version: string };
  readonly feedback: string;
};
