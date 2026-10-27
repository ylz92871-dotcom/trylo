import type { CliContext } from "./context.js";
import type { PermissionAction, PermissionDecision, PermissionRequestContext } from "../../ports/permission.js";
import { decision } from "../../ports/permission.js";
import type { AskUserRequest } from "../../domain/ask-user.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import { stdioAnswer, stdioPrompt, stdioResponse } from "./stdio-control.js";
import type { ToolPort } from "../../ports/tools.js";

type Io = Pick<CliContext, "readLine" | "stdout" | "newId" | "now">;
const TTL_MS = 10 * 60 * 1000;
type Reply = NonNullable<ReturnType<typeof stdioResponse>>["response"];

/** One reader owns stdin. Correlated replies never consume guidance or another request's answer. */
export function createStdioSession(io: Io) {
  const pending = new Map<string, (reply: Reply | undefined) => void>();
  const queued: string[] = [];
  const cancel = new AbortController();
  let closed = false;
  let agentTools: ToolPort | undefined;
  let agentInputs = 0;

  const write = (frame: object): void => io.stdout(`${JSON.stringify(frame)}\n`);
  const warn = (code: string, message: string): void => write({ type: "warning", code, message });
  const enqueue = (text: string): boolean => {
    if (closed || queued.length >= 32) { warn("input_not_accepted", "The guidance channel is closed or full; this message was not accepted."); return false; }
    queued.push(text); return true;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    agentTools = undefined;
    for (const settle of [...pending.values()]) settle(undefined);
  };
  const request = (requestId: string, body: object, valid: (reply: Reply) => boolean, signal?: AbortSignal): Promise<Reply | undefined> => {
    if (closed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const settle = (reply: Reply | undefined): void => {
        if (reply !== undefined && !valid(reply)) {
          warn("invalid_control_response", "The response does not answer the pending request; it is still waiting.");
          return;
        }
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (reply === undefined) write({ type: "control_cancel_request", request_id: requestId });
        resolve(reply);
      };
      const abort = (): void => settle(undefined);
      const timer = setTimeout(abort, TTL_MS);
      pending.set(requestId, settle);
      signal?.addEventListener("abort", abort, { once: true });
      write({ type: "control_request", request_id: requestId, expires_at: io.now() + TTL_MS, request: body });
    });
  };
  const pump = async (): Promise<void> => {
    try {
      while (!closed) {
        const line = await io.readLine();
        if (closed) return;
        if (line === undefined) { cancel.abort(); close(); return; }
        const reply = stdioResponse(line);
        if (reply !== undefined) {
          const settle = pending.get(reply.requestId);
          if (settle) settle(reply.response);
          else warn("stale_control_response", "The reply has no pending request; nothing was approved or answered.");
          continue;
        }
        const text = stdioPrompt(line);
        if (text !== undefined) {
          enqueue(text);
          continue;
        }
        // Match the legacy interrupt command; it cancels through the ordinary
        // turn signal, never by killing a process that may be writing a file.
        let frame: unknown;
        try { frame = JSON.parse(line) as unknown; } catch { /* rejected below */ }
        if (typeof frame === "object" && frame !== null && "type" in frame && frame.type === "subagent_input") {
          const input = frame as Record<string, unknown>;
          const requestId = typeof input.requestId === "string" ? input.requestId : "";
          const target = typeof input.target === "string" ? input.target : "";
          const message = typeof input.message === "string" ? input.message.trim() : "";
          const mode = input.mode;
          const action = input.action;
          const cancelling = action === "cancel";
          const respond = (accepted: boolean, error?: string): void => write({ type: "subagent_input_result", requestId, accepted,
            ...(error === undefined ? {} : { error }) });
          if (!requestId || !target || (!cancelling && !message) || message.length > 16000 || agentInputs >= 32
            || (action !== undefined && action !== "cancel")
            || (cancelling ? mode !== undefined || input.message !== undefined
              : mode !== undefined && mode !== "append" && mode !== "replace_queued" && mode !== "restart")) {
            respond(false, "补充要求无效或发送队列已满。"); continue;
          }
          const tools = agentTools;
          const toolName = cancelling ? "close_agent" : "send_input";
          if (tools === undefined || !tools.snapshot().some(tool => tool.name === toolName)) {
            respond(false, "当前运行不接收智能体补充要求。"); continue;
          }
          agentInputs += 1;
          void tools.execute({ name: toolName, toolCallId: `host-${requestId}`,
            arguments: cancelling ? { target, force: true } : { target, message,
              ...(typeof mode === "string" ? { mode } : {}) } }, cancel.signal)
            .then(result => {
              if (result.outcome === "result") respond(true);
              else respond(false, "message" in result ? result.message : "本轮已停止，要求未送达。");
            }, () => respond(false, "发送失败，要求未送达。"))
            .finally(() => { agentInputs -= 1; });
          continue;
        }
        if (typeof frame === "object" && frame !== null && "type" in frame && frame.type === "control_request"
          && "request" in frame && typeof frame.request === "object" && frame.request !== null
          && "subtype" in frame.request && frame.request.subtype === "interrupt") {
          cancel.abort(); close(); continue;
        }
        warn("invalid_control_frame", "Unrecognized control frame; no action was taken.");
      }
    } catch {
      warn("control_input_failed", "The control input channel failed; the turn was cancelled.");
      cancel.abort(); close();
    }
  };
  return {
    signal: cancel.signal,
    start: () => { void pump(); },
    close,
    bindAgentTools: (tools: ToolPort | undefined): void => { agentTools = tools; },
    enqueue,
    pendingInput: (turnId: string): ReadonlyArray<AddressedUserInput> => queued.splice(0).map(text => ({ text, mode: "steer", turnId })),
    async approval(action: PermissionAction, context?: PermissionRequestContext): Promise<PermissionDecision> {
      const requestId = io.newId("approval");
      const reply = await request(requestId, { subtype: "can_use_tool", tool_name: action.name,
        tool_use_id: action.toolCallId, input: action.arguments,
        ...(context?.requester === undefined ? {} : { requester: context.requester }) },
      reply => reply.behavior === "allow" || reply.behavior === "deny", context?.signal ?? cancel.signal);
      if (reply === undefined) return context?.signal?.aborted ? decision("cancelled")
        : closed ? decision("cancelled", "once", "input_closed") : decision("expired");
      return stdioAnswer(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: requestId, response: reply,
      } }), requestId) ?? decision("denied", "once", "policy_denied");
    },
    question: (question: AskUserRequest, signal: AbortSignal) => request(question.requestId,
      { subtype: "ask_user_question", questions: question.questions }, reply => reply.status === "dismissed"
        || (reply.status === "submitted" && typeof reply.answers === "object" && reply.answers !== null && !Array.isArray(reply.answers)), signal),
  };
}

export type StdioSession = ReturnType<typeof createStdioSession>;
