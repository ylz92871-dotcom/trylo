import type {
  ToolCallRequest,
  ToolOutcome,
  ToolPort,
  ToolSandbox,
} from "../../../ports/tools.js";
import { planMutation } from "../../sandbox/planner.js";
import { createCallCancellationRegistry, linkedSignal } from "../call-cancellation.js";
import { MUTATING_BINDINGS } from "./bindings.js";
import { createWriteQueue, type WriteQueue } from "./atomic-write.js";
import { executeApplyPatch } from "./apply-patch-tool.js";
import { executeEditFile } from "./edit-tool.js";
import { executeNotebookEdit } from "./notebook-edit.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "./names.js";
import { executeShell } from "./shell-tool.js";
import { createNodeSpawner, type ShellSpawner } from "./shell-spawn.js";
import type { ProcessSessionRegistry } from "../../process-session/session-registry.js";
import type { ShellModeResult } from "../../sandbox/shell-mode.js";
import { executeWriteFile } from "./write-tool.js";
import { MutationPathError, pathCheckedQueue } from "./path-checked-queue.js";

/**
 * The mutating tools.
 *
 * Nothing here decides policy. The sandbox object is required, not optional in
 * spirit: with no sandbox there is nothing that can bound a write, so the tools
 * refuse to exist rather than exist unbounded. Execution then re-plans through
 * the same pure function the sandbox used, which means a call cannot drift
 * between "was allowed" and "will do".
 */

export type ToolVisibility = {
  /** True when this tool must not appear in the catalog at all. */
  readonly isDenied: (name: string) => boolean;
};

export type MutatingToolsConfig = {
  readonly sandbox: ToolSandbox;
  readonly spawner?: ShellSpawner;
  /**
   * Where `runInBackground` commands go. Injected rather than constructed here
   * so the tools and the session observers share one registry — two registries
   * would mean a session started by one is invisible to the other, which is the
   * "production unreachable" defect in a different costume.
   */
  readonly sessions?: ProcessSessionRegistry | undefined;
  readonly visibility?: ToolVisibility;
  readonly writeQueue?: WriteQueue;
  /**
   * New notebook cell ids (WP13 L13). Injected so id choice is a caller
   * decision with a deterministic test seam; absent means the executor's
   * random default. Threaded to `notebook_edit`, not shared with other tools.
   */
  readonly idGenerator?: (() => string) | undefined;
  /** The machine commands run on; a seam with a default, see `ShellRunnerConfig`. */
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * The run's interpreter decision (WP05 C06/C07). Read once, at plan time:
   * the planner turns an approved command into a shell shape, and the spawner
   * never re-reads the string. Absent is the direct path.
   */
  readonly shellMode?: ShellModeResult;
};

export function createMutatingTools(config: MutatingToolsConfig): ToolPort {
  const queue = pathCheckedQueue(config.writeQueue ?? createWriteQueue(), config.sandbox.policy);
  const spawner = config.spawner ?? createNodeSpawner();
  const edits = { writeQueue: queue };
  const cancellations = createCallCancellationRegistry();
  return {
    snapshot() {
      const denied = config.visibility;
      return MUTATING_BINDINGS.filter((binding) => denied?.isDenied(binding.name) !== true);
    },
    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      try {
        const verdict = config.sandbox.evaluate(call);
        if (!verdict.ok) {
          return { outcome: "error", code: verdict.code, message: verdict.message };
        }
        const planned = planMutation(config.sandbox.policy, call, config.shellMode);
        if (!planned.ok) {
          return { outcome: "error", code: planned.code, message: planned.message };
        }
        if (call.name === WRITE_FILE_TOOL) {
          return await executeWriteFile(edits, call, planned.plan, signal);
        }
        if (call.name === EDIT_FILE_TOOL) {
          return await executeEditFile(edits, call, planned.plan, signal);
        }
        if (call.name === NOTEBOOK_EDIT_TOOL) {
          // WP13 (L13): cell edits write through the same atomic queue.
          return await executeNotebookEdit(
            {
              writeQueue: queue,
              ...(config.idGenerator === undefined ? {} : { idGenerator: config.idGenerator }),
            },
            call,
            planned.plan,
            signal,
          );
        }
        if (call.name === APPLY_PATCH_TOOL) {
          return await executeApplyPatch({ writeQueue: queue, policy: config.sandbox.policy }, call, planned.plan, signal);
        }
        if (call.name === RUN_SHELL_TOOL) {
          // The only mutating tool that owns something stoppable: a process tree.
          // It runs under a signal that fires on either the turn's cancel or this
          // call's own stop, so `cancel(toolCallId)` below actually reaches the
          // command instead of only the turn.
          const own = cancellations.begin(call.toolCallId);
          const link = linkedSignal(signal, own.signal);
          try {
            return await executeShell(
              {
                spawner,
                stdoutWriter: { policy: config.sandbox.policy, writeQueue: queue },
                sessions: config.sessions,
                ...(config.platform !== undefined ? { platform: config.platform } : {}),
              },
              call,
              planned.plan,
              link.signal,
            );
          } finally {
            link.release();
            cancellations.end(call.toolCallId);
          }
        }
        return { outcome: "error", code: "unknown_tool", message: `unknown_tool:${call.name}` };
      } catch (error) {
        if (signal.aborted) return { outcome: "cancelled" };
        if (error instanceof MutationPathError) return { outcome: "error", code: error.code, message: error.message };
        throw error;
      }
    },
    async cancel(toolCallId: string): Promise<void> {
      // Asks any running call to stop, and says whether one was there. A call
      // that has already settled answers false, which is not a failure: there
      // was nothing left to stop.
      cancellations.cancel(toolCallId);
    },
  };
}
