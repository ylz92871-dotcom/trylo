// Trylo Desktop — CLI control protocol (stream-json control frames).
//
// The CLI is spawned with `--permission-prompt-tool stdio` (see
// trylo-runner.ts). When a tool needs approval it writes a control_request
// line on stdout and blocks until the host answers with a control_response
// line on stdin:
//
//   → {"type":"control_request","request_id":"…","request":{"subtype":
//      "can_use_tool","tool_name":"Bash","input":{…},"title"?:…}}
//   ← {"type":"control_response","response":{"subtype":"success",
//      "request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}
//   ← … or {"behavior":"deny","message":"…"}
//
// A pending request may be retracted by the CLI with
// {"type":"control_cancel_request","request_id":"…"}. Shapes verified
// against the CLI bundle (migration spec §6.4, Code path).

/** Display provenance from the owning CLI; never an alternate permission owner. */
export interface MemberApprovalRequester {
  readonly kind: 'subagent';
  readonly taskId: string;
  readonly executionId: string;
  readonly teamRunId: string;
  readonly memberId: string;
  readonly displayName: string;
  readonly role: string;
}

function memberRequester(value: unknown): MemberApprovalRequester | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const field = r[key];
    return typeof field === 'string' && field.trim().length > 0 && field.length <= 256 ? field : undefined;
  };
  const taskId = text('taskId'); const executionId = text('executionId'); const teamRunId = text('teamRunId');
  const memberId = text('memberId'); const displayName = text('displayName'); const role = text('role');
  if (r['kind'] !== 'subagent' || !taskId || !executionId || !teamRunId || !memberId || !displayName || !role) return undefined;
  return { kind: 'subagent', taskId, executionId, teamRunId, memberId, displayName, role };
}

export interface ControlPermissionFrame {
  readonly kind: 'permission';
  readonly requestId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly title?: string;
  readonly requester?: MemberApprovalRequester;
}

export interface ControlCancelFrame {
  readonly kind: 'cancel';
  readonly requestId: string;
}

export interface ControlInputFrame {
  readonly kind: 'input';
  readonly requestId: string;
  readonly questions: readonly (import('@trylo/work').InputRequestQuestion & { readonly multiSelect?: boolean })[];
}

export type ControlFrame = ControlPermissionFrame | ControlCancelFrame | ControlInputFrame;

/** Shared text-only user frame for both CLI transports. */
export function buildUserPrompt(prompt: string): string {
  return `${JSON.stringify({ type: 'user', session_id: '', message: {
    role: 'user', content: [{ type: 'text', text: prompt }],
  }, parent_tool_use_id: null })}\n`;
}

/** Classify one already-JSON-parsed stdout line. Returns null for anything
 *  that is not an answerable control frame (other control subtypes —
 *  set_model, interrupt, … — belong to the CLI's own loop, not ours). */
export function parseControlFrame(parsed: unknown): ControlFrame | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o['type'] === 'control_request') {
    const requestId = typeof o['request_id'] === 'string' ? o['request_id'] : '';
    if (!requestId) return null;
    const request = o['request'];
    if (!request || typeof request !== 'object') return null;
    const r = request as Record<string, unknown>;
    if (r['subtype'] === 'ask_user_question') {
      const questions = r['questions'];
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return null;
      const seen = new Set<string>();
      for (const q of questions) {
        if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !q.id || seen.has(q.id)
          || typeof q.header !== 'string' || typeof q.question !== 'string' || !q.question
          || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
          || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')) return null;
        seen.add(q.id);
        if (q.options.some((option: unknown) => !option || typeof option !== 'object'
          || !('label' in option) || typeof option.label !== 'string'
          || !('description' in option) || typeof option.description !== 'string')) return null;
      }
      return { kind: 'input', requestId, questions };
    }
    if (r['subtype'] !== 'can_use_tool') return null;
    const toolName = typeof r['tool_name'] === 'string' ? r['tool_name'] : '';
    if (!toolName) return null;
    const requester = memberRequester(r['requester']);
    return {
      kind: 'permission',
      requestId,
      toolName,
      ...(requester ? { requester } : {}),
      input:
        r['input'] && typeof r['input'] === 'object' && !Array.isArray(r['input'])
          ? (r['input'] as Record<string, unknown>)
          : {},
      ...(typeof r['title'] === 'string' && r['title'].trim() !== '' ? { title: r['title'] } : {}),
    };
  }
  if (o['type'] === 'control_cancel_request') {
    const requestId = typeof o['request_id'] === 'string' ? o['request_id'] : '';
    return requestId ? { kind: 'cancel', requestId } : null;
  }
  return null;
}

/** Host → CLI: stop one running task (SDK `stop_task`). `taskId` is the
 *  CLI task id or the parent Agent `tool_use_id` (Team seat id). */
export function buildStopTaskRequest(taskId: string, requestId?: string): string {
  const id = requestId ?? `stop-task-${Date.now().toString(36)}`;
  return `${JSON.stringify({
    type: 'control_request',
    request_id: id,
    request: { subtype: 'stop_task', task_id: taskId },
  })}\n`;
}

/** Build the stdin line answering a pending request. `allow` passes the
 *  ORIGINAL input back unmodified (updatedInput) — the pet grants the tool
 *  call as asked; it never edits tool inputs. */
export function buildControlResponse(
  requestId: string,
  allow: boolean,
  input: Record<string, unknown> = {},
  denyMessage = 'Denied from the Trylo desktop companion.',
  reason?: 'policy_denied',
): string {
  const response = allow
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: denyMessage, ...(reason ? { reason } : {}) };
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}
