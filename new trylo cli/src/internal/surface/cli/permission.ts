import type {
  PermissionAction,
  PermissionDecision,
  PermissionPort,
  PermissionResolution,
  PermissionTicket,
  PermissionRequestContext,
} from "../../ports/permission.js";
import { decision } from "../../ports/permission.js";
export { decision } from "../../ports/permission.js";
export type { PermissionAction, PermissionDecision } from "../../ports/permission.js";

/**
 * Permission ports for the CLI.
 *
 * Two rules are load-bearing here:
 *
 *  - a non-interactive run fails closed: with nobody to ask, a mutating call is
 *    denied. `--allow-writes` narrows that to workspace writes only and never
 *    to `run_shell`. A separate explicit tool allowance can approve shell;
 *  - nothing here remembers a decision by itself. The same answers are handed
 *    to every prompt, and whether an approval is remembered is decided by the
 *    grant cache in `loop/permission-grants.ts`, which keys it on the call's
 *    fingerprint so "approve this" can never mean "approve anything".
 */

export function createDenyAllPermission(): PermissionPort {
  let counter = 0;
  return {
    async request(action: PermissionAction): Promise<PermissionTicket> {
      counter += 1;
      return { ticketId: `deny-${counter}`, toolCallId: action.toolCallId };
    },
    async awaitDecision(_ticketId: string): Promise<PermissionDecision> {
      return decision("denied", "once", "policy_denied");
    },
  };
}

/**
 * An explicit opt-in for non-interactive runs: the named tools are approved one
 * call at a time, and every other tool is denied. The set is supplied by the
 * composition root. `--allow-writes` supplies workspace writes; an explicit
 * `--allow-tools` may also supply an external tool such as `run_shell`.
 */
export function createAllowToolsPermission(allowedNames: ReadonlySet<string>, actionAllowed: (action: PermissionAction) => boolean = () => true): PermissionPort {
  const pending = new Map<string, PermissionAction>();
  let counter = 0;
  return {
    inheritance: {
      canUseTool: name => allowedNames.has(name),
      decide: action => decision(allowedNames.has(action.name) && actionAllowed(action) ? "approved" : "denied", "once"),
    },
    async request(action: PermissionAction): Promise<PermissionTicket> {
      counter += 1;
      const ticketId = `allow-tools-${counter}`;
      pending.set(ticketId, action);
      return { ticketId, toolCallId: action.toolCallId };
    },
    async awaitDecision(ticketId: string): Promise<PermissionDecision> {
      const action = pending.get(ticketId);
      pending.delete(ticketId);
      const allowed = action !== undefined && allowedNames.has(action.name) && actionAllowed(action);
      return decision(allowed ? "approved" : "denied", "once", allowed ? undefined : "policy_denied");
    },
  };
}

export type InteractivePermissionIo = {
  readonly supportsMemberApproval?: true;
  /** Writes the prompt to stderr so stdout stays a pure protocol stream. */
  readonly prompt: (text: string) => void;
  /** Reads one line; `undefined` means the input ended. */
  readonly readLine: () => Promise<string | undefined>;
  /** UI can provide a structured approval without parsing the text prompt. */
  readonly requestApproval?: (action: PermissionAction, context?: PermissionRequestContext) => Promise<PermissionDecision>;
  readonly onApproval?: (event: ApprovalLifecycle) => void;
};

export type ApprovalLifecycle =
  | { readonly kind: "waiting"; readonly action: PermissionAction }
  | { readonly kind: "settled"; readonly action: PermissionAction; readonly decision: PermissionDecision }
  | { readonly kind: "failed"; readonly action: PermissionAction };

/**
 * `s` remembers this exact call for the session; `d` denies the tool for the
 * session. Everything else decides one call and then forgets it, so a mistake
 * cannot outlive the prompt that made it.
 */
export type InteractiveAnswer =
  | { readonly resolution: "approved"; readonly scope: "once" | "session" }
  | { readonly resolution: "denied"; readonly scope: "once" | "session" }
  | { readonly resolution: "cancelled"; readonly scope: "once" };

function decide(answer: string | undefined): InteractiveAnswer {
  if (answer === undefined) {
    return { resolution: "cancelled", scope: "once" };
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") {
    return { resolution: "approved", scope: "once" };
  }
  if (normalized === "s" || normalized === "session") {
    return { resolution: "approved", scope: "session" };
  }
  if (normalized === "d") {
    return { resolution: "denied", scope: "session" };
  }
  if (normalized === "c" || normalized === "cancel") {
    return { resolution: "cancelled", scope: "once" };
  }
  return { resolution: "denied", scope: "once" };
}

async function awaitCancellableApproval(answer: Promise<PermissionDecision>, signal?: AbortSignal): Promise<PermissionDecision> {
  if (signal === undefined) return answer;
  if (signal.aborted) return decision("cancelled");
  let abort!: () => void;
  const cancelled = new Promise<PermissionDecision>(resolve => {
    abort = () => { resolve(decision("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([answer, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function resolveInteractiveAnswer(answer: string | undefined): InteractiveAnswer {
  return decide(answer);
}

export function createInteractivePermission(io: InteractivePermissionIo): PermissionPort {
  const pending = new Map<string, { readonly action: PermissionAction; readonly context?: PermissionRequestContext }>();
  let counter = 0;
  return {
    ...(io.supportsMemberApproval === true && io.requestApproval !== undefined ? { supportsMemberApproval: true as const } : {}),
    async request(action: PermissionAction, context?: PermissionRequestContext): Promise<PermissionTicket> {
      counter += 1;
      const ticketId = `ask-${counter}`;
      pending.set(ticketId, { action, ...(context === undefined ? {} : { context }) });
      return { ticketId, toolCallId: action.toolCallId };
    },
    async awaitDecision(ticketId: string): Promise<PermissionDecision> {
      const waiting = pending.get(ticketId);
      pending.delete(ticketId);
      if (waiting === undefined) throw new Error(`unknown approval ticket: ${ticketId}`);
      const { action, context } = waiting;
      if (context?.signal?.aborted) return decision("cancelled");
      io.onApproval?.({ kind: "waiting", action });
      try {
        const answered = io.requestApproval === undefined
          ? await readApproval(io, action)
          : await awaitCancellableApproval(io.requestApproval(action, context), context?.signal);
        io.onApproval?.({ kind: "settled", action, decision: answered });
        return answered;
      } catch (error) {
        // Release the UI's input ownership even when its reader fails.
        io.onApproval?.({ kind: "failed", action });
        throw error;
      }
    },
  };
}

/**
 * The prompt names the call, not just the tool: approving `write_file` says
 * nothing about *which* file, and an operator deserves to see the difference.
 */
function describeAction(action: PermissionAction): string {
  const summary = Object.entries(action.arguments)
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${summarizeValue(value)}`)
    .join(" ");
  return summary.length === 0
    ? `${action.name} (${action.toolCallId})`
    : `${action.name}(${summary}) (${action.toolCallId})`;
}

function summarizeValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) {
    return "?";
  }
  return text.replace(/\s+/g, " ");
}

async function readApproval(io: InteractivePermissionIo, action: PermissionAction): Promise<PermissionDecision> {
  for (;;) {
    io.prompt(`allow ${describeAction(action)}? [y]once [s]remember exact call [n]deny [d]disable tool [c]cancel: `);
    const answer = await io.readLine();
    if (answer === undefined) return decision("cancelled", "once", "input_closed");
    const normalized = answer.trim().toLowerCase();
    if (!["y", "yes", "s", "session", "n", "no", "d", "c", "cancel"].includes(normalized)) {
      io.prompt("Choose y/s/n/d/c; the command has not run.\n");
      continue;
    }
    const resolved = decide(normalized);
    const reason = resolved.resolution === "denied" ? "user_denied" : resolved.resolution === "cancelled" ? "user_cancelled" : undefined;
    return decision(resolved.resolution, resolved.scope, reason);
  }
}

export function isDenyingResolution(resolution: PermissionResolution): boolean {
  return resolution === "denied" || resolution === "cancelled" || resolution === "expired";
}
