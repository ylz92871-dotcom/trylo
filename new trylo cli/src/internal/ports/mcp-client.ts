import type { JsonObject, JsonValue } from "../protocol/envelope.js";

/**
 * MCP stdio client port.
 *
 * This port describes *a conversation with one child process*, nothing more. It
 * has no opinion about whether the tools it discovers may run: the annotations
 * a server publishes are hints from a party Trylo does not control, and this
 * layer records them without believing them.
 *
 * Three facts are load-bearing and are stated in types rather than comments:
 *
 *  1. `McpToolSpec.needsApproval` is the literal `true`. It is not a boolean
 *     that happens to default to true. A server that declares every tool
 *     read-only cannot produce a spec that looks pre-approved, so no policy
 *     written against this type can be talked out of asking.
 *  2. `annotationsTrust` is the literal `"untrusted"`. Hints travel with the
 *     spec for display and for a future approval summary; they never travel
 *     alone.
 *  3. Connecting is not authorising. See `mcpTrustInvariants` below — the
 *     functions mirror `tooling/catalog/mcp-trust.ts`, restated here so this
 *     package's own boundary test can assert them without importing the
 *     learning-side module.
 *
 * Capabilities this package does not implement (`elicitation`, `sampling`,
 * and the multi-round-trip `input_required` result) are refused *inside the
 * client*, before they can reach a caller. D3 §10.11 is the reason: a single
 * `execute(): Promise<Outcome>` cannot represent "the tool is waiting for a
 * human", so letting one through would either hang a turn or be silently
 * dropped. Neither is acceptable, so the server is told no and then closed.
 */

/** Protocol revisions this package is willing to speak. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

export const DEFAULT_MCP_PROTOCOL_VERSION: McpProtocolVersion = "2025-03-26";

/**
 * The default deadline for a resource listing round trip.
 *
 * Listings are fan-out reads a caller triggers implicitly (one per server per
 * model call), so the port carries a default rather than demanding one at
 * every call site — but the default is still finite: a listing without a
 * deadline is not schedulable, exactly like a call or a read. It matches the
 * tool-call envelope (`DEFAULT_MCP_CALL_TIMEOUT_MS` in `mcp-runtime/mount.ts`)
 * by value, not by reference: the contract owns its default, the runtime
 * table owns its own, and neither imports the other.
 */
export const DEFAULT_MCP_LIST_TIMEOUT_MS = 30_000;
export function isSupportedProtocolVersion(value: string): value is McpProtocolVersion {
  return (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/**
 * Every hint the spec defines, kept as received. A hint that is absent is
 * absent — this type does not invent defaults, because "the server said
 * nothing" and "the server said false" are different observations.
 */
export type McpToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
};

export type McpToolSpec = {
  /** As the server named it, before any Trylo namespacing. */
  readonly serverToolName: string;
  /** `mcp__<server>__<tool>`; the name a caller may actually use. */
  readonly qualifiedName: string;
  readonly serverId: string;
  readonly description: string;
  /** JSON Schema for the arguments, validated only to be a JSON object. */
  readonly inputSchema: JsonObject;
  readonly annotations: McpToolAnnotations;
  readonly annotationsTrust: "untrusted";
  /** Constant `true`. See the module comment. */
  readonly needsApproval: true;
};

export type McpConnectFailureCode =
  | "command_not_found"
  | "spawn_failed"
  | "handshake_timeout"
  | "unsupported_protocol_version"
  | "handshake_rejected"
  | "framing"
  | "child_exited"
  | "already_connected"
  | "invalid_server_info"
  | "needs_auth"
  | "closed";

export type McpConnectFailure = {
  readonly ok: false;
  readonly code: McpConnectFailureCode;
  readonly detail: string;
};

export type McpToolListFailureCode =
  | "not_initialized"
  | "protocol_error"
  | "framing"
  | "child_exited"
  | "invalid_tool_spec"
  | "needs_auth";

export type McpToolListFailure = {
  readonly ok: false;
  readonly code: McpToolListFailureCode;
  readonly detail: string;
};

export type McpCallFailureCode =
  | "not_initialized"
  | "unknown_tool"
  | "invalid_arguments"
  | "timeout"
  | "child_crashed"
  | "framing"
  | "protocol_error"
  | "capability_unsupported"
  | "needs_auth"
  | "stderr_overflow";

export type McpCallFailure = {
  readonly ok: false;
  readonly code: McpCallFailureCode;
  readonly detail: string;
};

/**
 * The outcome of one `tools/call`, in this package's own vocabulary.
 *
 * The shape mirrors `ToolOutcome` from `ports/tools.ts` on purpose so a future
 * adapter can map it without loss — but it is a *separate* type, because
 * `ports/tools.ts` belongs to the loop's contract and this package is not
 * allowed to widen it. `cancelled` keeps its own terminal state for the same
 * reason it does there: a user interrupt is not a tool failure.
 */
/** Transient transport bytes. The runtime must materialize validated images
 * before returning a ToolOutcome; these never enter the durable journal. */
export type McpInlineImage = { readonly mimeType: string; readonly data: string };

export type McpToolOutcome =
  | {
      readonly outcome: "result";
      readonly value: JsonObject;
      readonly output: string;
      readonly truncated: boolean;
      readonly inlineImages?: ReadonlyArray<McpInlineImage>;
    }
  | { readonly outcome: "error"; readonly code: string; readonly message: string }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "unknown"; readonly code: string; readonly message: string };

export type McpCallRequest = {
  readonly qualifiedName: string;
  readonly arguments: JsonObject;
  /** Finite and positive. A call without a deadline is not schedulable. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type McpServerInfo = {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: McpProtocolVersion;
  /** Capabilities exactly as advertised, for the record. */
  readonly capabilities: JsonObject;
  /** Instructions the server volunteered, if any. */
  readonly instructions?: string;
};

/**
 * One MCP resource, as `resources/list` published it.
 *
 * A resource is *content addressed by URI*, not a callable tool: the URI is
 * opaque to Trylo (a `file://` URI is the server's authority, not a workspace
 * path, and grants no implicit trust). Reading one is approval-gated through
 * the runtime resource tools, exactly like calling a server tool.
 */
export type McpResource = {
  /** Opaque identifier. Non-empty; entries without one are dropped, not repaired. */
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly annotations: McpToolAnnotations;
  readonly annotationsTrust: "untrusted";
};

/** One URI template, as `resources/templates/list` published it. */
export type McpResourceTemplate = {
  /** Opaque template (e.g. `file:///logs/{date}.log`). Never expanded locally. */
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly annotations: McpToolAnnotations;
  readonly annotationsTrust: "untrusted";
};

/** One content item of a `resources/read` result. */
export type McpResourceContent =
  | { readonly kind: "text"; readonly uri: string; readonly mimeType?: string; readonly text: string }
  | { readonly kind: "binary"; readonly uri: string; readonly mimeType?: string; readonly byteLength: number };

export type McpResourceReadResult = {
  readonly contents: ReadonlyArray<McpResourceContent>;
};

export type McpResourceListResult = {
  readonly resources: ReadonlyArray<McpResource>;
  readonly nextCursor?: string;
};

export type McpResourceTemplatesResult = {
  readonly templates: ReadonlyArray<McpResourceTemplate>;
  readonly nextCursor?: string;
};

export type McpResourceFailureCode =
  | "not_initialized"
  | "invalid_arguments"
  | "invalid_resource"
  | "timeout"
  | "cancelled"
  | "child_crashed"
  | "framing"
  | "protocol_error"
  | "needs_auth";

export type McpResourceFailure = {
  readonly ok: false;
  readonly code: McpResourceFailureCode;
  readonly detail: string;
};

export type McpReadResourceRequest = {
  /** Opaque to Trylo; passed verbatim to the server that published it. */
  readonly uri: string;
  /** Finite and positive. A read without a deadline is not schedulable. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type McpStdioClient = {
  /** Performs `initialize` + `initialized` and validates the version. */
  connect(): Promise<{ readonly ok: true; readonly value: McpServerInfo } | McpConnectFailure>;
  listTools(): Promise<
    | { readonly ok: true; readonly value: ReadonlyArray<McpToolSpec> }
    | McpToolListFailure
  >;
  callTool(
    request: McpCallRequest,
  ): Promise<
    | { readonly ok: true; readonly outcome: McpToolOutcome }
    | McpCallFailure
  >;
  /** `resources/list`. A `cursor` scopes pagination to one listing. */
  listResources(
    cursor?: string,
    timeoutMs?: number,
  ): Promise<{ readonly ok: true; readonly value: McpResourceListResult } | McpResourceFailure>;
  /** `resources/templates/list`. */
  listResourceTemplates(
    cursor?: string,
    timeoutMs?: number,
  ): Promise<{ readonly ok: true; readonly value: McpResourceTemplatesResult } | McpResourceFailure>;
  /** `resources/read`. The URI travels verbatim; its content is untrusted. */
  readResource(
    request: McpReadResourceRequest,
  ): Promise<{ readonly ok: true; readonly value: McpResourceReadResult } | McpResourceFailure>;
  /** Idempotent. After this, every other call fails with `closed`. */
  close(): Promise<void>;
  /** Whether the child is still running and the session usable. */
  isConnected(): boolean;
  /** Diagnostics: bytes seen on stderr so far, and whether any were dropped. */
  stderrDiagnostics(): { readonly bytes: number; readonly truncated: boolean };
};

/**
 * Mirror of `tooling/catalog/mcp-trust.ts`, restated locally so this package's
 * boundary test can assert the three constants without importing the learning
 * side. If the two ever disagree, the learning-side file is the authority.
 */
export const mcpTrustInvariants = {
  transportIsPermission: false,
  schemaIsTrustProof: false,
  connectionGrantsActivation: false,
} as const;

/** Annotations are data, never a decision. Present so callers cannot forget. */
export function annotationsAreHints(_annotations: McpToolAnnotations): true {
  return true;
}

/** True when two specs describe the same callable tool. */
export function sameQualifiedName(spec: McpToolSpec, name: string): boolean {
  return spec.qualifiedName === name;
}

export function jsonValueIsObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
