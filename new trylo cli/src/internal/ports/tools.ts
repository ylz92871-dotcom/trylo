import type { JsonObject } from "../protocol/envelope.js";
import type { ImageReference } from "../protocol/image-reference.js";
import type { FileAccessMode } from "./filesystem.js";
export type { FileAccessMode } from "./filesystem.js";

/**
 * What the loop is allowed to know about a tool before calling it.
 * Everything here is declarative so the tool catalog can be hashed into the
 * session runtime fingerprint.
 */
export type ToolSideEffectClass = "read_only" | "workspace_write" | "external";

export type ToolOutputLimits = {
  readonly maxBytes: number;
  readonly maxLines: number;
};

export type ToolBinding = {
  readonly name: string;
  readonly description: string;
  readonly sideEffect: ToolSideEffectClass;
  /**
   * Whether this tool may run at the same time as another tool in the same
   * batch. Absent means **no**: an undeclared tool takes the exclusive lock and
   * behaves exactly as it did before parallelism existed (WP22.1 / C05).
   *
   * Deliberately *not* derived from `sideEffect`. The two answer different
   * questions — `sideEffect` is what a call may do to the world, this is whether
   * two calls may overlap — and they disagree in both directions. A network
   * fetch is `external` and overlaps perfectly well. In the other direction,
   * `ask_user_question` is `read_only` yet must not overlap a sibling: it is the
   * tool that waits for a person before it returns (`adapters/tools/ask-user/
   * index.ts:30`), and a member that waits holds up a batch whose settlement is
   * ordered and cannot skip it. Its answers are keyed by `requestId`, so
   * overlapping it would not mix two replies up — the cost is a stalled batch,
   * not a lost answer. Either way the scheduler would have to guess about a
   * fact the tool already knows.
   */
  readonly parallelSafe?: boolean | undefined;
  /** JSON Schema object; also sent to the provider as the tool spec. */
  readonly parameters: JsonObject;
  readonly needsApproval: boolean;
  readonly timeoutMs: number;
  readonly outputLimits: ToolOutputLimits;
};

export type ToolCallRequest = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
};

/**
 * `cancelled` is its own terminal state, not an error: a cancelled tool is a
 * normal outcome of a user interrupt and must never be reported to the model
 * as a tool failure.
 */
export type ToolOutcome =
  | {
      readonly outcome: "result";
      readonly value: JsonObject;
      readonly output: string;
      readonly truncated: boolean;
      readonly images?: ReadonlyArray<ImageReference>;
    }
  | { readonly outcome: "error"; readonly code: string; readonly message: string }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "unknown"; readonly code: string; readonly message: string };

export type ToolPort = {
  snapshot(): ReadonlyArray<ToolBinding>;
  execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome>;
  cancel(toolCallId: string): Promise<void>;
};

export const TOOL_RESULT_TRUNCATION_CODE = "output_truncated";

// ---------------------------------------------------------------------------
// Execution sandbox (P03). Types live in `ports` because the loop must be able
// to consult the sandbox *before* asking for permission, and `loop/**` is not
// allowed to import `adapters/**`.
// ---------------------------------------------------------------------------

/**
 * Frozen for this package. `danger_full_access` is deliberately absent:
 * needing it is an architecture change, not a flag flip.
 */
export const SANDBOX_MODES = ["workspace_write", "read_only", "deny_all"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];


/**
 * `restricted` is the only value. Nothing in this package is allowed to open
 * the network, and no tool here declares otherwise.
 */
export const NETWORK_ACCESS_MODES = ["restricted"] as const;
export type NetworkAccess = (typeof NETWORK_ACCESS_MODES)[number];

export type SandboxPolicy = {
  readonly mode: SandboxMode;
  readonly network: NetworkAccess;
  /** Canonical workspace root; fileAccess selects the separate target scope. */
  readonly workspaceRoot: string;
  /** Trusted original workspace spelling, mapped to the frozen physical root. */
  readonly workspaceAlias?: string;
  /** Explicit host delegation; absent keeps the workspace boundary. */
  readonly fileAccess?: FileAccessMode;
  /** Writes above this size are rejected, never silently truncated. */
  readonly maxWriteBytes: number;
  /** Executable may only be a bare name; absolute paths and `cd` are refused. */
  readonly allowAbsoluteExecutable: boolean;
};

export type SandboxVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The admission gate. It answers one question — may this exact call be placed
 * before a human at all — and it is consulted *before* `permission.request`,
 * because asking someone to approve something the sandbox already forbids
 * would make the sandbox advisory.
 */
export type ToolSandbox = {
  readonly policy: SandboxPolicy;
  evaluate(call: ToolCallRequest): SandboxVerdict;
  /** Additional argument-dependent approval; never replaces binding.needsApproval. */
  requiresApproval?(call: ToolCallRequest): boolean;
};

/**
 * A completed file mutation, carried in a successful `ToolOutcome.value`. The
 * loop turns it into the journal's `file_write` fact so the durable record
 * states what changed on disk, not merely that a tool succeeded.
 */
export type ToolFileWriteEffect = {
  readonly kind: "file_write";
  readonly path: string;
  readonly bytes: number;
  readonly mode: "created" | "overwritten" | "patched" | "deleted" | "moved";
};

export const TOOL_FILE_WRITE_KEY = "fileWrite";
