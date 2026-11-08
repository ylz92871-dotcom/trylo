import type { ToolCall } from "../contract/execution.js";
import type { ReduceInput } from "../domain/input.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { DoomLoopTracker } from "./doom-loop.js";
import type { PermissionGrantCache } from "./permission-grants.js";
import type { ToolResultRecord } from "./tool-execution.js";
import { runToolFor, settleToolOutcome } from "./tool-execution.js";
import { lookupToolBinding } from "./tool-boundary.js";
import { runPermissionFor } from "./tool-permission.js";

/**
 * Running one permission gate and one tool call, split out of `runner.ts` (ADR
 * `2026-09-16-ADR-循环迭代间隙开冻` §4.2).
 *
 * The guards themselves live in `tool-permission.ts` and `tool-execution.ts`;
 * this file only supplies what they may do to an in-flight turn, and it holds no
 * state of its own — everything it needs arrives through `host`, so the runner
 * keeps ownership of the engine.
 *
 * `abortSignal` is threaded in rather than read from a global: a cancelled turn
 * must stop the tool that is already running, not the next one.
 */

export type ToolRunnerHost = {
  readonly emit: (kind: string, payload: JsonObject) => void;
  readonly dispatch: (input: ReduceInput) => Promise<void>;
  readonly nextEventId: () => string;
  /** The current domain state, read fresh: a dispatch may have changed it. */
  readonly callFor: (toolCallId: string) => ToolCall | undefined;
  readonly recordResult: (item: ToolResultRecord) => void;
  readonly grants: PermissionGrantCache;
  readonly doom: DoomLoopTracker;
  readonly abortSignal: AbortSignal;
  /** Undo is made here or not at all: once per turn, before the first write. */
  readonly beforeWrite: (toolName: string) => Promise<void>;
  /**
   * Feeds one successful tool outcome into the turn's net-diff tracker
   * (WP11/C20). Optional so older hosts keep their shape; absent means the
   * turn runs exactly as it did without net-diff tracking.
   */
  readonly noteTurnDiff?: (tool: string, value: JsonObject) => void;
};

/**
 * Permission for one tool call. A call that has vanished from the state is
 * reported as a permission failure rather than thrown: the turn is still running
 * and a missing call is a fact the journal should carry.
 */
export async function runPermission(
  host: ToolRunnerHost,
  ports: Parameters<typeof runPermissionFor>[1],
  toolCallId: string,
  name: string,
): Promise<void> {
  const call = host.callFor(toolCallId);
  if (call === undefined) {
    await host.dispatch({
      type: "permission_failed",
      eventId: host.nextEventId(),
      toolCallId,
      message: "unknown_tool_call",
    });
    return;
  }

  await runPermissionFor(
    {
      emit: host.emit,
      dispatch: host.dispatch,
      nextEventId: host.nextEventId,
      reportFailedResult: (id, tool, text) => host.recordResult({
        toolCallId: id,
        name: tool,
        output: text,
        truncated: false,
        outcome: "failed",
      }),
    },
    ports,
    { toolCallId, name, arguments: call.arguments, grants: host.grants, doom: host.doom },
  );
}

/**
 * Executing one approved tool call. The outcome translation lives in
 * `tool-execution.ts`; this only locates the call and hands over the signal.
 */
export async function runTool(
  host: ToolRunnerHost,
  tools: Parameters<typeof runToolFor>[1],
  toolCallId: string,
  cancelled: () => boolean = () => host.abortSignal.aborted,
): Promise<void> {
  const call = host.callFor(toolCallId);
  if (call === undefined) {
    await host.dispatch({
      type: "tool_unknown",
      eventId: host.nextEventId(),
      toolCallId,
      message: "unknown_tool_call",
    });
    return;
  }

  const lookup = lookupToolBinding(tools, call.name);
  if (lookup.kind === "unavailable") {
    await settleToolOutcome(host, call, lookup.outcome);
    return;
  }

  if (cancelled()) {
    await settleToolOutcome(host, call, { outcome: "cancelled" });
    return;
  }

  if (lookup.binding.sideEffect === "workspace_write") {
    await host.beforeWrite(call.name);
  }

  if (cancelled()) {
    await settleToolOutcome(host, call, { outcome: "cancelled" });
    return;
  }

  await runToolFor(
    {
      emit: host.emit,
      dispatch: host.dispatch,
      nextEventId: host.nextEventId,
      recordResult: host.recordResult,
      ...(host.noteTurnDiff === undefined ? {} : { noteTurnDiff: host.noteTurnDiff }),
    },
    tools,
    { toolCallId, name: call.name, arguments: call.arguments },
    host.abortSignal,
  );
}
