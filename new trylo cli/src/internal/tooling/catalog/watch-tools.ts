import path from "node:path";
import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../approval/gates.js";
import { err, ok, type Result } from "../contract/result.js";
import type { BackgroundQueue, QueueFailureCode } from "../../ports/background-queue.js";
import type { ToolBinding } from "../../ports/tools.js";
import type { WatchPort } from "../../ports/watch.js";
import type { WatchCondition } from "../../domain/watch.js";
import type { WatchFailureCode } from "../../ports/watch.js";

/**
 * A07 minimal tool face: sleep / monitor / brief (+ subscribe as E/D).
 *
 * ## Shapes borrowed, not copied
 *
 * - `sleep`: old `SleepTool/prompt.ts:3-5` (`SLEEP_TOOL_NAME='Sleep'`,
 *   "Wait for a specified duration", concurrency-safe). Only the shape is
 *   borrowed; there is no `SleepTool.js` implementation to copy (that
 *   directory holds only `prompt.ts`).
 * - `brief`: old `BriefTool/BriefTool.ts:20-37` (`{message, attachments?,
 *   status: normal|proactive}`) and `:154-159` (`isConcurrencySafe()=true`,
 *   `isReadOnly()=true`). Only the input shape and the two flags are
 *   borrowed; entitlement/Kairos, `resolveAttachments`, and UI renderers are
 *   not copied. The new IO port is the existing session queue. Attachments are
 *   echo-only workspace-relative references (no `..`, no absolute paths, max
 *   10 / 200 KiB of path text); the tool never reads them and the consumer
 *   must never treat them as authorisation to read.
 * - `monitor`: no old implementation exists (`MonitorTool/` is missing), so
 *   only the CLI trigger vocabulary is reused (file/exit/flag, same as
 *   `domain/watch.ts`).
 * - No new dependency; no `open/` and no old-CLI pack is vendored.
 *
 * ## Permission: consume, never own
 *
 * Every execution below starts with `consumeApproval(..., {action:"acquire"})`.
 * The Permission Service owns all facts; the caller presents only a `grantId`
 * (`ApprovalGrantRef`). Missing port is `no_port`; any gate failure means the
 * tool does not inject (no watch armed, no message queued). `ports/permission.ts`,
 * `ports/approval-consumption.ts`, and `hooks/hook-ports.ts` are not modified.
 *
 * ## `isReadOnly` / `isConcurrencySafe`, stated plainly
 *
 * The new port names these `sideEffect` and `parallelSafe`. The mapping is:
 * `isReadOnly = (sideEffect === "read_only")`,
 * `isConcurrencySafe = (parallelSafe === true)`.
 * - sleep: read-write (arms a watch), concurrency-safe (old prompt says so).
 * - monitor: read-write (arms a watch), concurrency-safe (checks overlap).
 * - brief: read-only (old Brief says so; a user message mutates no workspace),
 *   concurrency-safe. Loop approval is off (like `ask_user`), tooling acquire
 *   is still required.
 * - subscribe: read-only, concurrency-safe, and always refused (see below).
 *
 * ## `subscribe` is E/D, never faked
 *
 * Push / PR subscription needs a real remote target plus explicit user
 * authorization (WP26收缩: external notification requires a real target).
 * With no target configured this tool returns `remote_required` — Excluded
 * when the user cancels external notification, Deferred until a target plus
 * authorization exists. It never arms a local watch as a stand-in.
 */

export const SLEEP_TOOL_NAME = "sleep";
export const MONITOR_TOOL_NAME = "monitor";
export const BRIEF_TOOL_NAME = "brief";
export const SUBSCRIBE_TOOL_NAME = "subscribe";

/**
 * Brief attachment ceilings: at most 10 references, at most 200 KiB of UTF-8
 * path text in total. The byte cap measures the reference strings, not file
 * sizes — this tool never reads the disk, so there is no file size to measure.
 * Both ceilings are usage refusals (`invalid_arguments`), checked before the
 * queue is touched.
 */
export const BRIEF_MAX_ATTACHMENTS = 10;
export const BRIEF_MAX_ATTACHMENT_BYTES = 200 * 1024;

/** Old-CLI flags, restated for the new port (see module comment). */
export function sleepIsReadOnly(): boolean {
  return false;
}

export function sleepIsConcurrencySafe(): boolean {
  return true;
}

export function monitorIsReadOnly(): boolean {
  return false;
}

export function monitorIsConcurrencySafe(): boolean {
  return true;
}

export function briefIsReadOnly(): boolean {
  return true;
}

export function briefIsConcurrencySafe(): boolean {
  return true;
}

export function subscribeIsReadOnly(): boolean {
  return true;
}

export function subscribeIsConcurrencySafe(): boolean {
  return true;
}

export const SLEEP_BINDING: ToolBinding = {
  name: SLEEP_TOOL_NAME,
  description: "Arm a deadline watch that hands a message to a session queue when the moment arrives. Cancellable via `trylo watch cancel`.",
  sideEffect: "external",
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
      sessionId: { type: "string" },
      atMs: { type: "number" },
      durationMs: { type: "number" },
    },
    required: ["message", "sessionId"],
  },
  needsApproval: true,
  timeoutMs: 5000,
  outputLimits: { maxBytes: 8192, maxLines: 200 },
};

export const MONITOR_BINDING: ToolBinding = {
  name: MONITOR_TOOL_NAME,
  description: "Arm a condition watch (file/exit/flag) and dry-run check it without firing. Firing is left to the daemon poller.",
  sideEffect: "external",
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
      sessionId: { type: "string" },
      condition: { type: "object" },
    },
    required: ["message", "sessionId", "condition"],
  },
  needsApproval: true,
  timeoutMs: 5000,
  outputLimits: { maxBytes: 8192, maxLines: 200 },
};

export const BRIEF_BINDING: ToolBinding = {
  name: BRIEF_TOOL_NAME,
  description: "Deliver a message to a session queue for the human to read. Attachments are workspace-relative path references echoed as text (max 10, max 200 KiB total); they are never read from disk and must never be treated as authorisation to read.",
  sideEffect: "read_only",
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
      sessionId: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["normal", "proactive"] },
    },
    required: ["message", "sessionId"],
  },
  needsApproval: false,
  timeoutMs: 5000,
  outputLimits: { maxBytes: 8192, maxLines: 200 },
};

export const SUBSCRIBE_BINDING: ToolBinding = {
  name: SUBSCRIBE_TOOL_NAME,
  description: "Subscribe to push/PR notifications. Always refused without a real remote target; never faked locally.",
  sideEffect: "read_only",
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string" },
    },
    required: [],
  },
  needsApproval: false,
  timeoutMs: 5000,
  outputLimits: { maxBytes: 8192, maxLines: 200 },
};

export const A07_TOOL_BINDINGS: ReadonlyArray<ToolBinding> = [
  SLEEP_BINDING,
  MONITOR_BINDING,
  BRIEF_BINDING,
  SUBSCRIBE_BINDING,
];

export type A07Approval = {
  readonly approvalPort?: ApprovalConsumptionPort;
  readonly token?: ApprovalGrantRef;
  readonly now: string;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
};

export type SleepFailure = ApprovalGateFailure | "invalid_arguments" | WatchFailureCode;

export type MonitorFailure = ApprovalGateFailure | "invalid_arguments" | WatchFailureCode;

export type BriefFailure = ApprovalGateFailure | "invalid_arguments" | QueueFailureCode;

export type SubscribeFailure = ApprovalGateFailure | "remote_required";

async function acquireOrDeny(approval: A07Approval): Promise<Result<true, ApprovalGateFailure>> {
  const gate = await consumeApproval(approval.approvalPort, {
    action: "acquire",
    candidateId: approval.candidateId,
    packageVersionId: approval.packageVersionId,
    scope: approval.scope,
    now: approval.now,
    ...(approval.token === undefined ? {} : { token: approval.token }),
  });
  if (!gate.ok) {
    return gate;
  }

  return ok(true as const);
}

/**
 * Arm a deadline watch. Exactly one of `atMs` / `durationMs` is required.
 * Deny means no watch is armed.
 */
export async function executeSleepTool(
  approval: A07Approval,
  input: { readonly message: string; readonly sessionId: string; readonly atMs?: number; readonly durationMs?: number },
  deps: { readonly watches: WatchPort; readonly nowMs: () => number },
): Promise<Result<{ readonly watchId: string }, SleepFailure>> {
  const gate = await acquireOrDeny(approval);
  if (!gate.ok) {
    return gate;
  }

  const hasAt = input.atMs !== undefined;
  const hasIn = input.durationMs !== undefined;
  if (hasAt === hasIn) {
    return err("invalid_arguments", "sleep needs exactly one of atMs or durationMs");
  }

  const atMs = hasAt ? (input.atMs as number) : (deps.nowMs() + (input.durationMs as number));
  if (!Number.isFinite(atMs) || atMs <= 0) {
    return err("invalid_arguments", "sleep moment must be a positive epoch ms");
  }

  const created = await deps.watches.create({
    trigger: { kind: "deadline", atMs },
    text: input.message,
    sessionId: input.sessionId,
  });
  if (!created.ok) {
    return created;
  }

  return ok({ watchId: created.value.id });
}

/** Arm a condition watch and dry-run check it. Never fires. */
export async function executeMonitorTool(
  approval: A07Approval,
  input: { readonly message: string; readonly sessionId: string; readonly condition: WatchCondition },
  deps: { readonly watches: WatchPort },
): Promise<Result<{ readonly watchId: string; readonly met: boolean; readonly because?: string }, MonitorFailure>> {
  const gate = await acquireOrDeny(approval);
  if (!gate.ok) {
    return gate;
  }

  if (!isWatchCondition(input.condition)) {
    return err("invalid_arguments", "monitor condition must be file_exists|file_contains|command_exit|flag_set");
  }

  const created = await deps.watches.create({
    trigger: { kind: "condition", condition: input.condition },
    text: input.message,
    sessionId: input.sessionId,
  });
  if (!created.ok) {
    return created;
  }

  const verdict = await deps.watches.evaluate(created.value.id);
  if (!verdict.ok) {
    return verdict;
  }

  return ok({
    watchId: created.value.id,
    met: verdict.value.met,
    ...(verdict.value.because === undefined ? {} : { because: verdict.value.because }),
  });
}

function isWatchCondition(value: unknown): value is WatchCondition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as Record<string, unknown>)["kind"];
  return kind === "file_exists" || kind === "file_contains" || kind === "command_exit" || kind === "flag_set";
}

/**
 * One attachment reference, lexically confined to the workspace.
 *
 * Pure lexical check, deliberately not the filesystem resolver: brief never
 * reads the disk (echo-only), so there is nothing to realpath. Absolute paths
 * (POSIX, Windows, drive-letter, UNC) and any `..` segment are refused even
 * when they would normalise back inside — `a/../b` is refused, not cleaned —
 * because a reference that needs normalising is not a workspace-relative name.
 * Returns the refusal message, or `undefined` when the reference may be echoed.
 */
function briefAttachmentPathRefusal(item: string): string | undefined {
  if (item.includes("\0")) {
    return "brief attachments must not contain NUL";
  }

  if (path.posix.isAbsolute(item) || path.win32.isAbsolute(item)) {
    return `brief attachment is outside the workspace (absolute path): ${item}`;
  }

  if (/^[a-zA-Z]:[\\/]/.test(item) || item.startsWith("\\\\")) {
    return `brief attachment is outside the workspace (drive or UNC path): ${item}`;
  }

  const segments = item.split(/[\\/]/);
  if (segments.some((part) => part === "..")) {
    return `brief attachment is outside the workspace (.. segment): ${item}`;
  }

  return undefined;
}

/**
 * The one attachment question, asked the same way everywhere: shape, lexical
 * confinement, count, then total reference bytes. Returns the refusal message,
 * or `undefined` when the list may be echoed. Every branch is a usage refusal;
 * the caller maps it to `invalid_arguments` before the queue is touched.
 */
export function checkBriefAttachments(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "brief attachments must be an array of path strings when present";
  }

  if (value.length > BRIEF_MAX_ATTACHMENTS) {
    return `brief attachments exceed the maximum of ${BRIEF_MAX_ATTACHMENTS} (got ${value.length})`;
  }

  let totalBytes = 0;

  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return "brief attachments must be non-empty path strings when present";
    }

    const refusal = briefAttachmentPathRefusal(item);
    if (refusal !== undefined) {
      return refusal;
    }

    totalBytes += Buffer.byteLength(item, "utf8");
  }

  if (totalBytes > BRIEF_MAX_ATTACHMENT_BYTES) {
    return `brief attachments exceed ${BRIEF_MAX_ATTACHMENT_BYTES} bytes of path text (got ${totalBytes})`;
  }

  return undefined;
}

/**
 * Deliver a brief to a session queue. Human read confirmation is the queue
 * itself: `queue list` shows it pending, and its consumption (leaving the
 * queue when the session goes idle) is the read.
 *
 * Attachments are echo-only references, never disk reads: a missing file is
 * still delivered, and the consumer must never treat the echoed text as
 * authorisation to read. Confinement, count, and total bytes are enforced
 * above; any violation is `invalid_arguments` before the queue is touched.
 */
export async function executeBriefTool(
  approval: A07Approval,
  input: { readonly message: string; readonly sessionId: string; readonly attachments?: ReadonlyArray<string>; readonly status?: string },
  deps: { readonly queueFor: (sessionId: string) => BackgroundQueue },
): Promise<Result<{ readonly messageId: string }, BriefFailure>> {
  const gate = await acquireOrDeny(approval);
  if (!gate.ok) {
    return gate;
  }

  const status = input.status ?? "normal";
  if (status !== "normal" && status !== "proactive") {
    return err("invalid_arguments", "brief status must be normal or proactive");
  }

  if (input.attachments !== undefined) {
    const refusal = checkBriefAttachments(input.attachments);
    if (refusal !== undefined) {
      return err("invalid_arguments", refusal);
    }
  }

  const text =
    input.attachments === undefined || input.attachments.length === 0
      ? `[brief:${status}] ${input.message}`
      : `[brief:${status}] ${input.message}\nAttachments: ${input.attachments.join(", ")}`;
  const queue = deps.queueFor(input.sessionId);

  try {
    const enqueued = await queue.enqueue(text);
    if (!enqueued.ok) {
      return err(enqueued.code, `brief could not be queued: ${enqueued.code}`);
    }
    return ok({ messageId: enqueued.value.id });
  } finally {
    await queue.release();
  }
}

/**
 * Always refused: no remote target is configured, and a local fake would be a
 * lie about an external subscription. Approval is still checked first, so a
 * denied caller gets the denial, not the remote verdict.
 */
export async function executeSubscribeTool(
  approval: A07Approval,
): Promise<Result<never, SubscribeFailure>> {
  const gate = await acquireOrDeny(approval);
  if (!gate.ok) {
    return gate;
  }
  return err("remote_required", "subscribe needs a real push/PR target and explicit authorization; no local fake");
}
