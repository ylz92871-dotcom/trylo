import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import type { PermissionPort } from "../../ports/permission.js";

/** v1: additive fields are compatible. IDs are opaque; only this library creates references. */
export type ToolLibraryContext = { readonly memberId: string; readonly scope: string };

export type LibraryFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type LibraryResult<T> = { readonly ok: true; readonly value: T } | LibraryFailure;

export type ToolOrigin = {
  readonly kind: "builtin" | "mcp" | "plugin" | "learned" | "external";
  readonly label: string;
  readonly reference?: string;
  readonly version?: string;
};

export type ToolAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable" | "unknown"; readonly reason: string };

/** A projection, never a registration/permission writer. No secrets or executable source. */
export type ToolLibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly source: ToolOrigin;
  readonly availability: ToolAvailability;
  readonly runtimeName?: string;
  readonly lifecycle?: string;
};

export type ToolLibraryItem = ToolLibraryEntry & {
  readonly configured: boolean;
  readonly configuration: "configurable" | "blocked";
  readonly reason?: string;
};

export type ToolLibraryFilter = { readonly text?: string; readonly origin?: ToolOrigin["kind"]; readonly limit?: number };

export type ToolLibraryCatalog = { readonly formatVersion: 1; readonly items: readonly ToolLibraryItem[]; readonly total: number };

export type ToolRuntimeReference = {
  readonly toolId: string;
  readonly runtimeName: string;
  /** Exact binding, including schema/approval semantics; stale references fail closed. */
  readonly bindingHash: string;
};

export type ToolResolution = {
  readonly references: readonly ToolRuntimeReference[];
  readonly rejected: readonly { readonly toolId: string; readonly code: string }[];
  /** Mount into the existing Execution Loop. Its Permission/Sandbox remain mandatory. */
  readonly tools: ToolPort;
};

export type CapabilityDemand = {
  readonly requestKey: string; readonly capability: string; readonly taskId: string;
  /** Existing issue/job/grant/correlation references. Board remains their lifecycle and quota owner. */
  readonly relatedRefs?: readonly string[];
  /** A request to revise an existing learned asset; never edits an active package in place. */
  readonly targetToolId?: string;
};

export type CapabilityRequest = {
  readonly requestId: string;
  readonly state: string;
  readonly capability: string;
  readonly reason?: string;
  readonly assetVersionId?: string;
  readonly toolIds: readonly string[];
  readonly relatedRefs?: readonly string[];
};

export type CapabilityResponse =
  | { readonly kind: "existing"; readonly references: readonly ToolRuntimeReference[] }
  | { readonly kind: "request"; readonly request: CapabilityRequest };

export type ToolLibraryAccess = {
  /** Already opened tools from the owning runtime, before member selection. */
  readonly tools: ToolPort;
  readonly configuredNames: readonly string[] | undefined;
  readonly allowedNames?: readonly string[];
  readonly permission: Pick<PermissionPort, "isDenied">;
};

export type ToolLibrarySource = {
  readonly id: string;
  read(context: ToolLibraryContext): Promise<LibraryResult<readonly ToolLibraryEntry[]>>;
};

export type ToolLibraryLearning = {
  request(context: ToolLibraryContext, demand: CapabilityDemand, signal: AbortSignal): Promise<LibraryResult<CapabilityRequest>>;
  get(context: ToolLibraryContext, requestId: string): Promise<LibraryResult<CapabilityRequest>>;
};

export type ToolLibraryOptions = {
  readonly sources: readonly ToolLibrarySource[];
  readonly access: (context: ToolLibraryContext) => Promise<LibraryResult<ToolLibraryAccess>>;
  readonly learning?: ToolLibraryLearning;
  /** Existing member configuration writer. Never persist a library-owned selection. */
  readonly configure?: (context: ToolLibraryContext, runtimeNames: readonly string[]) => Promise<LibraryResult<void>>;
};

export type ToolLibrary = {
  query(context: ToolLibraryContext, filter?: ToolLibraryFilter): Promise<LibraryResult<ToolLibraryCatalog>>;
  resolve(context: ToolLibraryContext, toolIds: readonly string[]): Promise<LibraryResult<ToolResolution>>;
  resolveReferences(context: ToolLibraryContext, references: readonly ToolRuntimeReference[]): Promise<LibraryResult<ToolResolution>>;
  configure(context: ToolLibraryContext, toolIds: readonly string[]): Promise<LibraryResult<readonly ToolRuntimeReference[]>>;
  requestCapability(context: ToolLibraryContext, demand: CapabilityDemand, signal: AbortSignal): Promise<LibraryResult<CapabilityResponse>>;
  getRequest(context: ToolLibraryContext, requestId: string): Promise<LibraryResult<CapabilityRequest>>;
};

export type ToolMetadata = { readonly source: ToolOrigin; readonly capabilities?: readonly string[]; readonly lifecycle?: string };

export type ToolBindingMetadata = (binding: ToolBinding) => ToolMetadata;
