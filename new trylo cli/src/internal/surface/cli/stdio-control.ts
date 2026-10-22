import { decision, type PermissionAction, type PermissionDecision } from "../../ports/permission.js";
import type { CliContext } from "./context.js";
import { parseBootstrapContext, type BootstrapContext } from "./bootstrap-context.js";
import { isLegacyBootstrapText } from "./user-input-source.js";

type RecordValue = Record<string, unknown>;
type StdioControlIo = Pick<CliContext, "now" | "newId" | "stdout" | "readLine">;
const APPROVAL_TTL_MS = 10 * 60 * 1000;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    // Invalid transport input has no permission authority.
    return undefined;
  }
}

export function stdioResponse(line: string): { readonly requestId: string; readonly response: RecordValue } | undefined {
  const frame = parse(line);
  if (!record(frame) || frame.type !== "control_response" || !record(frame.response)) return undefined;
  const response = frame.response;
  if (response.subtype !== "success" || typeof response.request_id !== "string" || !record(response.response)) return undefined;
  return { requestId: response.request_id, response: response.response };
}

/** The same user frame Desktop sends to its legacy runner, text blocks only. */
export function stdioPrompt(line: string | undefined): string | undefined {
  return stdioUserPrompt(line)?.text;
}

export function stdioUserPrompt(line: string | undefined): { readonly text: string; readonly bootstrapContext?: BootstrapContext; readonly userSourceAvailable?: false } | undefined {
  if (line === undefined) return undefined;
  const frame = parse(line);
  if (!record(frame) || frame.type !== "user" || !record(frame.message) || frame.message.role !== "user") return undefined;
  const content = frame.message.content;
  const bootstrapContext = "bootstrap_context" in frame ? parseBootstrapContext(frame.bootstrap_context) : undefined;
  if (typeof content === "string") return content.trim() ? { text: content.trim(), ...(bootstrapContext === undefined ? {} : { bootstrapContext }),
    ...(isLegacyBootstrapText(content.trim()) ? { userSourceAvailable: false as const } : {}) } : undefined;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  return text ? { text, ...(bootstrapContext === undefined ? {} : { bootstrapContext }),
    ...(isLegacyBootstrapText(text) ? { userSourceAvailable: false as const } : {}) } : undefined;
}

export function stdioAnswer(line: string, requestId: string): PermissionDecision | undefined {
  const reply = stdioResponse(line);
  if (reply?.requestId !== requestId) return undefined;
  if (reply.response.behavior === "allow") return decision("approved");
  if (reply.response.behavior === "deny") return decision("denied", "once", reply.response.reason === "policy_denied" ? "policy_denied" : "user_denied");
  return undefined;
}

/** Serializes approval readers so parallel calls cannot consume each other's answers. */
export type StdioApprovalOptions = {
  readonly scheduleExpiry?: (ms: number, expired: () => void) => () => void;
};

function scheduleExpiry(ms: number, expired: () => void): () => void {
  const timer = setTimeout(expired, ms);
  return () => clearTimeout(timer);
}

export function createStdioApproval(ctx: StdioControlIo, options: StdioApprovalOptions = {}): (action: PermissionAction) => Promise<PermissionDecision> {
  let tail: Promise<void> = Promise.resolve();
  let pendingLine: Promise<string | undefined> | undefined;
  const sharedInput = { ...ctx, readLine: (): Promise<string | undefined> => {
    // A deadline cannot cancel the underlying input transport. Keep its one
    // outstanding read for the next request rather than starting a competing reader.
    pendingLine ??= ctx.readLine().then(line => { pendingLine = undefined; return line; }, error => { pendingLine = undefined; throw error; });
    return pendingLine;
  } };
  return action => {
    const result = tail.then(() => ask(sharedInput, action, options.scheduleExpiry ?? scheduleExpiry));
    // Release the queue on failure; the failed permission still propagates to the caller.
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

async function ask(ctx: StdioControlIo, action: PermissionAction, schedule: NonNullable<StdioApprovalOptions["scheduleExpiry"]>): Promise<PermissionDecision> {
  const requestId = ctx.newId("approval");
  const expiresAt = ctx.now() + APPROVAL_TTL_MS;
  ctx.stdout(`${JSON.stringify({ type: "control_request", request_id: requestId, expires_at: expiresAt, request: {
    subtype: "can_use_tool", tool_name: action.name, tool_use_id: action.toolCallId, input: action.arguments,
  } })}\n`);
  let cancelExpiry = (): void => undefined;
  const deadline = new Promise<{ readonly kind: "expired" }>(resolve => {
    cancelExpiry = schedule(APPROVAL_TTL_MS, () => resolve({ kind: "expired" }));
  });
  try {
    // Stale or malformed replies cannot approve a different call. Bound their count.
    for (let rejected = 0; rejected < 32; rejected += 1) {
      const read = await Promise.race([ctx.readLine().then(line => ({ kind: "line" as const, line })), deadline]);
      if (read.kind === "expired" || ctx.now() >= expiresAt) {
        ctx.stdout(`${JSON.stringify({ type: "control_cancel_request", request_id: requestId })}\n`);
        return decision("expired");
      }
      const line = read.line;
      if (line === undefined) {
        ctx.stdout(`${JSON.stringify({ type: "control_cancel_request", request_id: requestId })}\n`);
        return decision("cancelled", "once", "input_closed");
      }
      const answer = stdioAnswer(line, requestId);
      if (answer !== undefined) return answer;
      ctx.stdout(`${JSON.stringify({ type: "warning", code: "invalid_control_response", message: "Approval reply did not match the pending request; the call has not run." })}\n`);
    }
    ctx.stdout(`${JSON.stringify({ type: "control_cancel_request", request_id: requestId })}\n`);
    return decision("denied", "once", "policy_denied");
  } finally { cancelExpiry(); }
}
