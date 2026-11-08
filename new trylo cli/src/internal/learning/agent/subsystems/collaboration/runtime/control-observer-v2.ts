import { contentHashOf } from "../../../../control/hash.js";
import type { ToolCallRequest, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import type { ExposureV2, SessionOptionsV2 } from "./session-types-v2.js";
import type { CollaborationTimelineV2 } from "./timeline-v2.js";
import { collaborationExcerptV2 } from "./summary-v2.js";
import { HANDOFF_FIELDS } from "../domain/contracts.js";

type Task = { readonly taskId: string; readonly memberId: string; readonly role: string; readonly assignmentRef: string; ready: boolean };

type Pending = { readonly call: ToolCallRequest; readonly exposure?: ExposureV2 };

const controls = new Set(["spawn_agent", "send_input", "wait_agent", "resume_agent"]);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const row = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

/** Typed action tags do not prove effects: each operation has an actual-effect prerequisite. */
export function createCollaborationControlObserverV2(options: SessionOptionsV2, timeline: CollaborationTimelineV2,
  exposure: () => ExposureV2 | undefined) {
  const tasks = new Map<string, Task>(), pending = new Map<string, Pending>();
  const taskFor = (id: unknown) => typeof id === "string" ? tasks.get(id) : undefined;
  const actionFor = (item: ExposureV2 | undefined, call: ToolCallRequest) =>
    item?.selection.actions.find(action => action.actionId === call.arguments.learning_action_id);
  const observe = async (call: ToolCallRequest, result: ToolOutcome, waitMs: number): Promise<void> => {
    if (!options.enabled() || result.outcome !== "result") return;

    const current = exposure(), action = actionFor(current, call), context = timeline.context();
    const refs = [`control:${call.toolCallId}`];

    if (call.name === "spawn_agent") {
      const taskId = result.value.task_id, agentId = result.value.agent_id, memberId = result.value.member_id;
      const member = options.team.members.find(value => value.memberId === memberId);
      if (typeof taskId !== "string" || typeof agentId !== "string" || member === undefined) return;

      if (tasks.size >= 128) {
        options.warn("collaboration_task_capacity");
        return;
      }

      const task: Task = { taskId, memberId: member.memberId, role: member.baseRole,
        assignmentRef: `assignment:${contentHashOf(call.arguments.message)}`, ready: false };

      tasks.set(taskId, task);
      tasks.set(agentId, task);
      const all = [...new Map([...tasks.values()].map(value => [value.taskId, value])).values()];
      const dependencies = strings(result.value.dependencies);
      const reviewReady = ["reviewer", "verifier", "cad-verifier"].includes(member.baseRole)
        && dependencies.some(id => taskFor(id)?.ready === true);
      const evidenceRefs = [...refs, ...all.flatMap(value => [`task:${value.taskId}`, value.assignmentRef]).slice(-16),
        ...strings(result.value.allowed_tools).slice(0, 10).map(name => `allowed-tool:${name}`)].slice(0, 32);
      const assignment = await timeline.event({ id: `${call.toolCallId}:assigned`, context, dimension: "assignment", action: "assign_member",
        summary: `Parent assigned frozen member ${member.memberId} (${member.baseRole}) to task ${taskId}. Scope: ${collaborationExcerptV2(call.arguments.message)}`,
        evidenceRefs, metrics: { memberCount: options.team.members.length, taskCount: all.length } });
      const split = all.length >= 2 && new Set(all.map(value => value.assignmentRef)).size >= 2
        ? await timeline.event({ id: `${call.toolCallId}:decomposed`, context, dimension: "decomposition", action: "split_task",
          summary: `${all.length} child tasks with distinct assignment content were actually created.`, evidenceRefs,
          metrics: { taskCount: all.length, memberCount: options.team.members.length } }) : undefined;
      const review = reviewReady ? await timeline.event({ id: `${call.toolCallId}:review-scheduled`, context,
        dimension: "review", action: "schedule_review", summary: `Parent assigned ${member.baseRole} after observing a ready prerequisite's output.`,
        evidenceRefs: [...refs, ...dependencies.map(id => `task:${id}`).slice(0, 16)] }) : undefined;
      const eventId = action?.operation === "assign_member" ? assignment : action?.operation === "split_task" ? split
        : action?.operation === "schedule_review" ? review : undefined;

      await timeline.adopt(current, action?.actionId, eventId);
    }

    if (call.name === "send_input") {
      const submissionId = result.value.submission_id;
      if (typeof submissionId === "string") {
        if (pending.size >= 64) pending.delete(pending.keys().next().value ?? "");
        pending.set(submissionId, { call, ...(current === undefined ? {} : { exposure: current }) });
      }

      await timeline.event({ id: `${call.toolCallId}:queued`, context, dimension: "handoff", action: "handoff_queued",
        summary: `Parent queued a follow-up; queued acknowledgement is not delivery or adoption. Scope: ${collaborationExcerptV2(call.arguments.message)}`, evidenceRefs: refs });
    }

    if (call.name === "wait_agent") {
      const results = result.value.results;
      if (row(results)) for (const [id, value] of Object.entries(results)) {
        const task = taskFor(id);
        if (task !== undefined && row(value) && (value.phase === "awaiting_input" || value.phase === "terminal" && value.status === "completed")
          && typeof value.output === "string" && value.output.length > 0 && value.output_truncated !== true) task.ready = true;
      }

      const targets = strings(call.arguments.targets), known = targets.length > 0 && targets.every(id => taskFor(id) !== undefined);
      const waitId = await timeline.event({ id: `${call.toolCallId}:waited`, context, dimension: "waiting",
        action: "wait_for_dependency", summary: "Parent waited for member round states and available results through wait_agent.",
        evidenceRefs: [...refs, ...targets.map(id => `task:${taskFor(id)?.taskId ?? id}`).slice(0, 16)], metrics: { waitMs } });
      const syncId = await timeline.event({ id: `${call.toolCallId}:synchronized`, context, dimension: "synchronization", action: "synchronize",
        summary: "Parent refreshed its view of known member states and deliverable readiness.", evidenceRefs: refs });

      await timeline.adopt(current, known ? action?.actionId : undefined, action?.operation === "wait_for_dependency" ? waitId
        : action?.operation === "synchronize" ? syncId : undefined);
    }
  };

  return {
    wrap(tools: ToolPort): ToolPort {
      return { snapshot: () => tools.snapshot().map(binding => !controls.has(binding.name) ? binding : { ...binding,
        parameters: { ...binding.parameters, properties: { ...(row(binding.parameters.properties) ? binding.parameters.properties : {}),
          ...(binding.name !== "send_input" ? {} : { missing_handoff_fields: { type: "array", minItems: 1, maxItems: 4,
            items: { type: "string", enum: HANDOFF_FIELDS }, description: "To request missing context, list actual missing handoff fields. The host delivers an explicit request for these fields using the existing member input channel." } }),
          learning_action_id: { type: "string", minLength: 1, maxLength: 200,
            description: "Optional displayed collaboration action actually followed by this operation. It is not authority or proof of success." } } } }),
      cancel: id => tools.cancel(id), async execute(call, signal) {
        if (!controls.has(call.name)) return tools.execute(call, signal);

        const tag = call.arguments.learning_action_id;
        if (tag !== undefined && (typeof tag !== "string" || !tag || tag.length > 200)) return { outcome: "error",
          code: "invalid_learning_action_id", message: "Use a displayed action id or omit the optional tag." };

        const fields = call.arguments.missing_handoff_fields;
        if (fields !== undefined && (call.name !== "send_input" || !Array.isArray(fields) || fields.length < 1 || fields.length > 4
          || !fields.every(field => typeof field === "string" && HANDOFF_FIELDS.some(value => value === field)))) return { outcome: "error",
          code: "invalid_handoff_context_request", message: "List 1-4 canonical handoff fields on send_input." };

        const { learning_action_id: _tag, missing_handoff_fields: _fields, ...arguments_ } = call.arguments;
        const deliveredCall = Array.isArray(fields) ? { ...call, arguments: { ...call.arguments,
          message: `${String(call.arguments.message ?? "")}\n\n协作同步请求：请补充交接字段 ${fields.join(", ")} 的实际内容和可核对依据；未知处请明确说明。` } } : call;
        const executionArguments = Array.isArray(fields) ? { ...arguments_, message: deliveredCall.arguments.message! } : arguments_;
        const started = Date.parse(options.now());
        const result = await tools.execute({ ...call, arguments: executionArguments }, signal);

        try { await observe(deliveredCall, result, Math.max(0, Date.parse(options.now()) - started)); }
        catch { options.warn("collaboration_control_observer_unavailable"); }

        return result;
      } };
    },
    async delivered(round: CollaborationRound) {
      const delivery = round.delivery;
      if (delivery === undefined) return;

      const item = pending.get(delivery.submissionId);
      pending.delete(delivery.submissionId);
      const handoff = round.handoff;
      const refs = handoff === undefined ? [] : [...handoff.artifacts, ...handoff.evidence].map(ref =>
        ref.length <= 512 ? ref : `handoff-ref:${contentHashOf(ref)}`);
      const action = item === undefined ? undefined : actionFor(item.exposure, item.call);
      const actual = action !== undefined && ((action.operation === "share_reference" && refs.length > 0)
        || action.operation === "request_context" && strings(item?.call.arguments.missing_handoff_fields).length > 0
        || action.operation === "synchronize" && handoff !== undefined && handoff.pending.length + handoff.blockers.length > 0
        || action.operation === "replan" && (item?.call.arguments.mode === "restart" || item?.call.arguments.mode === "replace_queued")) ? action : undefined;
      const parentContext = item?.exposure?.selection.context ?? timeline.context();
      const id = await timeline.event({ id: `${delivery.submissionId}:delivered`, context: parentContext,
        dimension: actual?.dimension ?? "handoff", action: actual?.operation ?? "handoff_delivered",
        summary: `Recipient ${round.memberId} started the delivered instruction; canonical handoff ${handoff === undefined ? "absent" : "present"}.`,
        evidenceRefs: [`submission:${delivery.submissionId}`, `task:${round.taskId}`, ...refs.slice(0, 16)] });

      await timeline.adopt(item?.exposure, actual?.actionId, id);

      if (handoff !== undefined) await timeline.event({ id: `${delivery.submissionId}:received`, context: timeline.context(round),
        dimension: "information_sharing", action: refs.length > 0 ? "share_reference" : "handoff_received", summary: `Supplied handoff (claims require independent checks): scope=${collaborationExcerptV2(handoff.scope, 400)}; artifacts=${handoff.artifacts.length}, evidence=${handoff.evidence.length}; pending=${collaborationExcerptV2(handoff.pending.join("; "), 400)}; blockers=${collaborationExcerptV2(handoff.blockers.join("; "), 400)}.`,
        evidenceRefs: refs.slice(0, 16) });
    },
  };
}
