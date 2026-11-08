import type { ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import { CLOSE_AGENT_TOOL, RESUME_AGENT_TOOL, SEND_INPUT_TOOL, SPAWN_AGENT_TOOL, WAIT_AGENT_BINDING,
  SUBAGENT_CONTROL_BINDINGS, WAIT_AGENT_TOOL, LIST_AGENTS_BINDING, LIST_AGENTS_TOOL, RECONFIGURE_AGENT_BINDING, RECONFIGURE_AGENT_TOOL } from "./control-bindings.js";
import { roleCatalogDescription } from "./role.js";
import { boundedWaitResponse, type WaitMemberReader } from "./wait-response.js";
import type { SubagentStatus } from "./types.js";
import { systemTimerScheduler } from "./scheduler.js";
import { governanceFailureOutcome } from "./governance.js";
import { DEFAULT_AGENT_WAIT_MS, MAX_AGENT_WAIT_MS, waitForAgentReports } from "./control-observation.js";
import { ControlAgentSessions, AGENT_CLEANUP_WAIT_MS, type SubagentControlOptions } from "./control-session.js";
import { spawnSettings, inputMode, resultCursors, dependencyIds, controlFlag, controlText as text } from "./control-input.js";
import { handoffMessage, isSubagentHandoff } from "../protocol/subagent-handoff.js";
import { chooseSubagentRouting } from "./routing.js";
import { fixedTeamModel } from "./team.js";
import { memberConfigurationReceipt } from "./member-configuration.js";

export type { SubagentControlOptions } from "./control-session.js";

function number(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(args: JsonObject, key: string): ReadonlyArray<string> | undefined {
  const value = args[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function ok(value: JsonObject, output: string): ToolOutcome {
  return { outcome: "result", value, output, truncated: false };
}

function refuse(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

export function createSubagentControlTool(options: SubagentControlOptions): ToolPort {
  const agents = new ControlAgentSessions(options);
  const observers = new Map<string, AbortController>();
  let submissions = 0;

  const run = async (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> => {
    const args = call.arguments;
    switch (call.name) {
      case LIST_AGENTS_TOOL: {
        if (options.checkpoints === undefined) return refuse("unknown_tool", "Durable task recovery is unavailable in this run");

        const offset = args["offset"] ?? 0;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 128) return refuse("invalid_arguments", "offset must be an integer between 0 and 128");

        const rows = [...agents.listLive().map(value => ({ kind: "live", value })), ...agents.listRecoverable().map(value => ({ kind: "recoverable", value }))];
        let end = Math.min(rows.length, offset + 8);

        for (;;) {
          const page = rows.slice(offset, end);
          const value = { live: page.filter(item => item.kind === "live").map(item => item.value),
            recoverable: page.filter(item => item.kind === "recoverable").map(item => item.value), next_offset: end < rows.length ? end : null };
          if (Buffer.byteLength(JSON.stringify(value)) <= LIST_AGENTS_BINDING.outputLimits.maxBytes) return ok(value, JSON.stringify(value));
          if (end <= offset + 1) return refuse("agent_observation_too_large", "Task identity metadata exceeds the listing bound");
          end -= 1;
        }
      }
      case SPAWN_AGENT_TOOL: {
        const message = text(args, "message");
        if (message === undefined) {
          return refuse("invalid_arguments", "spawn_agent requires a non-empty message");
        }

        const memberId = text(args, "member_id");
        const agentType = text(args, "agent_type");
        const model = text(args, "model");

        if (args["member_id"] !== undefined && memberId === undefined) {
          return refuse("invalid_arguments", "member_id must be a non-empty string");
        }

        const configurationRef = text(args, "configuration_ref");
        if (args.configuration_ref !== undefined && (configurationRef === undefined || configurationRef.length > 512)) return refuse("invalid_arguments", "configuration_ref must be a bounded opaque reference");

        const configured = configurationRef === undefined ? undefined : await agents.configurationForSpawn(configurationRef, { message, agentType, memberId }, signal);

        if (signal.aborted) return { outcome: "cancelled" };

        if (configured !== undefined && configured.kind !== "ready") return ok({ status: configured.kind, reason: configured.reason,
          configuration_ref: configurationRef! }, "Expert configuration is not ready; no member was started.");

        const settings = spawnSettings(args);
        const dependencies = agents.assertDependencies(dependencyIds(args["depends_on"]));
        const forkParent = controlFlag(args, "fork_context");
        let forkMessages = forkParent
          ? typeof options.parentMessages === "function" ? options.parentMessages() : options.parentMessages
          : undefined;
        if (forkParent && forkMessages === undefined) {
          return refuse(
            "fork_context_unavailable",
            "This run carries no parent conversation to fork from",
          );
        }

        const route = options.routing === undefined ? undefined : await chooseSubagentRouting(options.routing, {
          executionId: call.toolCallId, message, signal,
          inheritedProfile: args["model"] === undefined && args["agent_type"] === undefined && args["member_id"] === undefined
            && options.team === undefined && !(options.roles ?? []).some(role => role.model !== undefined && role.model !== "inherit"),
          parentMessages: (typeof options.parentMessages === "function" ? options.parentMessages() : options.parentMessages) ?? [],
          ...(typeof args["fork_context"] !== "boolean" ? {} : { explicitFork: args["fork_context"] }),
        }, options.scheduler);

        if (signal.aborted) return { outcome: "cancelled" };

        if (route !== undefined) forkMessages = route.forkMessages;

        const entry = agents.start({
          ...(route === undefined ? {} : { routing: route.receipt, routingDiagnostics: route.diagnostics }),
          message, toolCallId: call.toolCallId, forkMessages, ...settings, dependencies,
          agentType, model, memberId,
          ...(configured?.kind === "ready" ? { configuration: configured.configuration, agentType: configured.agentType, memberId: configured.memberId } : {}),
        });

        return ok(
          {
            ...(entry.routingObserver === undefined ? {} : { routing: entry.routingObserver.report() }),
            agent_id: entry.agentId,
            nickname: entry.nickname,
            budget: entry.observation.budgetSnapshot(options.runtime.getGovernance().snapshot(entry.agentId)),
            idle_timeout_ms: entry.idleTimeoutMs,
            task_id: entry.taskId,
            role: entry.resolved.role.name,
            ...(entry.teamMember === undefined ? {} : { team_run_id: entry.teamMember.teamRunId, member_id: entry.teamMember.memberId }),
            allowed_tools: [...entry.resolved.allowedTools],
            dependencies: entry.dependencies,
            ...memberConfigurationReceipt(entry.configuration),
            // Said out loud rather than thrown: the role asked for tools this
            // parent cannot grant, and narrowing is the safe direction.
            ...(entry.resolved.withheld.length === 0 ? {} : { withheld: [...entry.resolved.withheld] }),
          },
          `agent ${entry.agentId}`,
        );
      }

      case RECONFIGURE_AGENT_TOOL: {
        const target = text(args, "target"), reference = text(args, "configuration_ref"), message = text(args, "message"), handoff = args.handoff;
        if (target === undefined || reference === undefined || reference.length > 512 || message === undefined || !isSubagentHandoff(handoff)) {
          return refuse("invalid_arguments", "reconfigure_agent requires target, configuration_ref, message and a complete typed handoff");
        }

        const entry = agents.get(target);
        if (entry === undefined) return refuse("unknown_agent", `No agent with id '${target}'`);

        const next = await agents.reconfigure(entry, reference, message, handoff, call.toolCallId, signal, spawnSettings(args).governance);
        if (next === "cancelled") return { outcome: "cancelled" };

        if ("kind" in next) return ok({ status: next.kind, reason: next.reason, task_id: entry.taskId }, "No configuration was applied; wait for the stated boundary or resource.");

        return ok({ status: "configured", agent_id: next.agentId, task_id: next.taskId, member_id: next.teamMember?.memberId ?? "",
          ...memberConfigurationReceipt(next.configuration) }, `configured ${next.taskId} after handoff`);
      }

      case SEND_INPUT_TOOL: {
        const target = text(args, "target");
        let message = text(args, "message");
        if (target === undefined || message === undefined) {
          return refuse("invalid_arguments", "send_input requires target and message");
        }

        const entry = agents.get(target);
        if (entry === undefined) {
          return refuse("unknown_agent", `No agent with id '${target}'`);
        }

        agents.assertInputAllowed(entry);
        const dependencies = agents.assertDependencies(dependencyIds(args["depends_on"]), entry.taskId);
        const inputDependencies = args["depends_on"] === undefined ? {} : { dependencies };
        const handoff = args["handoff"];
        if (handoff !== undefined) {
          if (!isSubagentHandoff(handoff)) return refuse("invalid_handoff",
            "handoff must contain exactly scope, artifacts[], evidence[], pending[] and blockers[]; no extra properties. Put source references in evidence or artifacts, and keep values within the schema limits.");
          message = handoffMessage(message, handoff);
        }

        const mode = inputMode(args);
        const receipt = { submissionId: `sub-${entry.agentId}-${++submissions}`, parentToolCallId: call.toolCallId };

        if (mode === "restart" || entry.parked) {
          agents.inputQueued(entry);

          if (mode === "restart") {
            await agents.stop(entry, "restarted_by_parent");
          }

          const next = await agents.resume(entry, message, call.toolCallId, signal, { receipt, ...inputDependencies,
            ...(isSubagentHandoff(handoff) ? { handoff } : {}) });
          if (next === "cancelled") return { outcome: "cancelled" };

          return ok({ submission_id: receipt.submissionId, agent_id: next.agentId, task_id: next.taskId,
            delivery: mode === "restart" ? "restarted" : "continued" }, `continued ${next.taskId}`);
        }

        const interrupt = mode === "replace_queued";
        if (!entry.channel.deliver({ message, interrupt, receipt, ...inputDependencies, ...(isSubagentHandoff(handoff) ? { handoff } : {}) })) {
          return entry.channel.open
            ? refuse("agent_input_queue_full", `Agent '${target}' has a full input queue; wait or replace queued input with interrupt`)
            : refuse("agent_closed", `Agent '${target}' is closed and takes no more input`);
        }

        agents.inputQueued(entry);
        entry.observation.requestInput();

        return ok({ submission_id: receipt.submissionId, agent_id: entry.agentId, task_id: entry.taskId,
          delivery: interrupt ? "replaced_queued" : "queued", active_round_interrupted: false }, `queued for ${target}`);
      }

      case WAIT_AGENT_TOOL: {
        const targets = list(args, "targets");
        if (targets === undefined || targets.length === 0) {
          return refuse("invalid_arguments", "wait_agent requires at least one target");
        }

        const requestedTimeout = number(args, "timeout_ms");
        if (args["timeout_ms"] !== undefined && (requestedTimeout === undefined || requestedTimeout < 0)) {
          return refuse("invalid_arguments", "timeout_ms must be a finite non-negative number");
        }

        const after = resultCursors(args, targets);
        const wakeOnReport = controlFlag(args, "wake_on_report");
        const releaseOnReady = controlFlag(args, "release_on_ready");
        const known = [...new Set(targets)].flatMap(target => {
          const entry = agents.get(target);
          return entry === undefined ? [] : [{ target, entry }];
        });
        if (known.length !== new Set(targets).size) {
          return refuse("unknown_agent", "wait_agent received an unknown agent id");
        }

        const observed = await waitForAgentReports({
          ready: () => targets.some(target => {
            const observation = agents.get(target)?.observation;
            return observation?.isReady(after.get(target)) === true
              || wakeOnReport && observation?.hasReportAfter(after.get(target)) === true;
          }),
          subscribe: listener => agents.subscribe(listener),
          timeoutMs: Math.min(requestedTimeout ?? DEFAULT_AGENT_WAIT_MS, MAX_AGENT_WAIT_MS),
          signal,
          scheduler: options.scheduler ?? systemTimerScheduler,
        });
        if (observed === "cancelled") return { outcome: "cancelled" };

        const readers: WaitMemberReader[] = [];

        for (const { target } of known) {
          const entry = agents.get(target);
          if (entry === undefined) return refuse("unknown_agent", "This task has left the bounded conversation history");

          if (releaseOnReady && entry.observation.isReady()) {
            agents.park(entry);
            const retired = await options.runtime.waitForRetirement(entry.agentId, AGENT_CLEANUP_WAIT_MS, signal);
            if (retired === "cancelled") return { outcome: "cancelled" };
          }

          const status = entry.handle.status();
          const cleanup = entry.resourceStop.snapshot();

          readers.push({ target, status, read: reportLimit => ({ ...entry.observation.snapshot(status, after.get(target),
            options.runtime.getGovernance().snapshot(entry.agentId), reportLimit), agent_id: entry.agentId, task_id: entry.taskId,
            round: entry.roundOffset + entry.observation.lastRound,
            nickname: entry.nickname, idle_timeout_ms: entry.idleTimeoutMs,
            dependencies: entry.dependencies,
            ...memberConfigurationReceipt(entry.configuration),
            ...(entry.routingObserver === undefined ? {} : { routing: entry.routingObserver.report() }),
            ...(entry.teamMember === undefined ? {} : { team_run_id: entry.teamMember.teamRunId, member_id: entry.teamMember.memberId }),
            ...(cleanup === undefined ? {} : { cleanup }) }) });
        }

        const answer = boundedWaitResponse(readers, observed === "timeout", WAIT_AGENT_BINDING.outputLimits.maxBytes);
        if (answer === undefined) return refuse("agent_observation_too_large", "Member metadata exceeds the result budget; collect fewer targets without advancing their cursors.");

        return ok(answer, JSON.stringify(answer));
      }

      case CLOSE_AGENT_TOOL: {
        const force = controlFlag(args, "force");
        const target = text(args, "target");
        const entry = target === undefined ? undefined : agents.get(target);
        if (target === undefined || entry === undefined) {
          return refuse("unknown_agent", `No agent with id '${target ?? ""}'`);
        }

        // Closing the channel ends the agent at the end of the round it is in,
        // which keeps the work it already did and reports `completed`. Forcing
        // is a different request: the execution is cancelled, then owned
        // resources and worker retirement must confirm before closed=true.
        entry.parked = false;
        entry.channel.close();

        if (force) {
          await agents.stop(entry, "closed_by_parent");
        }

        return ok({ closed: true, forced: force }, `closed ${target}`);
      }

      case RESUME_AGENT_TOOL: {
        const target = text(args, "target");
        const entry = target === undefined ? undefined : agents.get(target);

        if (target === undefined) {
          return refuse("unknown_agent", `No agent with id '${target ?? ""}'`);
        }

        if (entry === undefined) {
          const restored = await agents.restore(target, text(args, "message"), call.toolCallId, signal, spawnSettings(args).governance);
          if (restored === "cancelled") return { outcome: "cancelled" };
          return ok({ agent_id: restored.agentId, task_id: restored.taskId, nickname: restored.nickname,
            ...memberConfigurationReceipt(restored.configuration),
            recovery: "canonical_checkpoint", cursor_reset: true, resumed_from: target }, `recovered ${restored.taskId}; discard prior wait cursors`);
        }

        const current: SubagentStatus = entry.handle.status();
        if (current === "pending" || current === "running") {
          return refuse(
            "agent_still_running",
            `Agent '${target}' is '${current}'; it does not need resuming`,
          );
        }

        const settings = spawnSettings(args);
        const entry2 = await agents.resume(entry, text(args, "message"), call.toolCallId, signal, { governance: settings.governance });
        if (entry2 === "cancelled") return { outcome: "cancelled" };

        return ok({ agent_id: entry2.agentId, task_id: entry2.taskId, nickname: entry2.nickname,
          ...memberConfigurationReceipt(entry2.configuration),
          resumed_from: entry.agentId }, `resumed ${entry2.taskId}`);
      }

      default:
        return refuse("unknown_tool", `Unknown subagent control tool '${call.name}'`);
    }
  };

  return {
    // Codex does the same thing at `spec_plan.rs:753`: the spawn tool's
    // description carries whatever roles this run has, so the model chooses from
    // the configured set. With no roles the text is the plain one, unchanged.
    snapshot: () => {
      const recoveryBindings = options.checkpoints === undefined ? SUBAGENT_CONTROL_BINDINGS : [...SUBAGENT_CONTROL_BINDINGS, LIST_AGENTS_BINDING];
      const bindings = options.memberConfigurations === undefined ? recoveryBindings : [...recoveryBindings, RECONFIGURE_AGENT_BINDING];
      const roles = [...new Map((options.team?.members.map(member => member.role) ?? options.roles ?? [])
        .map(role => [role.name, role])).values()];
      const catalog = roleCatalogDescription(roles);
      if (catalog.length === 0) {
        return bindings;
      }

      const teamModels = options.team?.members.map(fixedTeamModel);
      const fixedModels = teamModels?.filter((model): model is string => model !== undefined);
      const modelChoices = fixedModels !== undefined && fixedModels.length > 0 && fixedModels.length === teamModels?.length
        ? [...new Set(fixedModels)] : undefined;

      return bindings.map((binding) =>
        binding.name === SPAWN_AGENT_TOOL
          ? {
              ...binding,
              description: `${binding.description}
${catalog}`,
              parameters: {
                type: "object",
                properties: {
                  ...(binding.parameters as { properties: Record<string, JsonValue> }).properties,
                  ...(options.team === undefined ? {} : { model: { type: "string",
                    ...(modelChoices === undefined ? {} : { enum: modelChoices }),
                    description: "Omit to use the selected member's configured model. If that member has a fixed model, any explicit value must match it. Members configured to inherit retain model overrides." } }),
                  ...(options.team === undefined ? {} : { member_id: { type: "string", enum: options.team.members.map(member => member.memberId),
                    description: "Frozen team member identity. Must match agent_type; use send_input for an already assigned member." } }),
                  agent_type: {
                    type: "string",
                    enum: roles.map((role) => role.name),
                    description: "A configured role; it can only narrow this child's tools.",
                  },
                },
                required: ["message"],
              },
            }
          : binding,
      );
    },
    async execute(call, signal): Promise<ToolOutcome> {
      if (signal.aborted) return { outcome: "cancelled" };

      // One active invocation owns the cancellation address until it settles.
      // Reusing an in-flight id must not replace that owner or execute effects.
      if (observers.has(call.toolCallId)) {
        return refuse("invalid_arguments", `Tool call '${call.toolCallId}' is already active`);
      }

      const observer = new AbortController();
      const cancel = (): void => { observer.abort(signal.reason); };

      signal.addEventListener("abort", cancel, { once: true });
      observers.set(call.toolCallId, observer);

      try {
        return await run(call, observer.signal);
      } catch (error) {
        if (observer.signal.aborted) return { outcome: "cancelled" };
        return governanceFailureOutcome(error);
      } finally {
        signal.removeEventListener("abort", cancel);
        observers.delete(call.toolCallId);
      }
    },
    async cancel(toolCallId): Promise<void> {
      // Cancel the observation, not a child that may have other waiters.
      observers.get(toolCallId)?.abort("tool_call_cancelled");
    },
  };
}
