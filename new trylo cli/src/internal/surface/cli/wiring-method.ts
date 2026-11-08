import path from "node:path";
import { wireMethodLearning, createExperienceModel, createExperienceFunding, createExperienceTools, createMethodFocusedLearning } from "../../learning/agent/subsystems/method/adapters/index.js";
import type { MethodBoard } from "../../learning/agent/subsystems/method/index.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { methodSwitchFor } from "../../integration/user-learning/index.js";
import type { MethodLearningInput } from "./wiring-optins.js";
import type { ToolGapRuntime } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { composeAdditionalTools } from "./additional-tools.js";
import { tryloHome } from "./session-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";

/**
 * The board, or nothing.
 *
 * The path is built here because this is the file that owns the composition
 * root, and it borrows `tryloHome` instead of spelling out the home directory:
 * a second copy of that formula would be right until the day `TRYLO_HOME` is
 * set, and then only one of the two homes would move.
 *
 * `now` is derived from the same injected clock as the compaction stamp, so a
 * test that pins the clock pins the board's timestamps too.
 *
 * The switch is a **total** one now (`method` / `user` / `all`), and the method
 * half is asked first: `methodSwitchFor` turns "either of the two values that
 * enable me" into the single word `wireMethodLearning` accepts. That word is
 * imported from the module that owns it, not restated here — and a switch that
 * does not enable the method half returns `undefined` *before* the board is
 * built, so `--learning=user` never creates a board directory.
 */
export function methodPortOf(input: { readonly learning?: MethodLearningInput; readonly nowMs?: number;
  readonly provider?: ProviderPort; readonly model?: string; readonly workspaceRoot?: string; readonly turnId?: string }): MethodBoard | undefined {
  const learning = input.learning;
  if (learning === undefined) {
    return undefined;
  }

  const methodSwitch = methodSwitchFor(learning.switch);
  if (methodSwitch === undefined) {
    return undefined;
  }

  const nowMs = input.nowMs ?? 0;
  const now = () => new Date(nowMs).toISOString();
  const boardRoot = path.join(tryloHome(learning.homeDir, learning.env), "learning", "board");
  const model = learning.deferReviewToCentral === true || input.provider === undefined || input.model === undefined || input.turnId === undefined || input.workspaceRoot === undefined
    ? undefined : createExperienceModel({ provider: input.provider, model: input.model, turnId: input.turnId,
      fundingFor: request => createExperienceFunding({ boardRoot, workspaceId: workspaceIdentity(input.workspaceRoot!), centralScope: input.workspaceRoot!,
        turnId: input.turnId!, now, request, enabled: () => methodSwitchFor(learning.switch) !== undefined,
        ...(learning.reviewGrant === undefined ? {} : { binding: learning.reviewGrant }) }) });

  return wireMethodLearning({
    switch: methodSwitch,
    boardRoot,
    now,
    emit: learning.emit,
    ...(model === undefined ? {} : { model }),
  });
}

/** The mounted owner consumes existing method grants; the PA never borrows collaboration funding. */
export function methodFocusedPortOf(input: { readonly learning?: MethodLearningInput; readonly nowMs?: number;
  readonly provider: ProviderPort; readonly model?: string; readonly workspaceRoot: string; readonly turnId?: string; readonly method?: MethodBoard }) {
  if (input.learning === undefined || methodSwitchFor(input.learning.switch) === undefined || input.model === undefined || input.turnId === undefined) return undefined;
  return createMethodFocusedLearning({ boardRoot: path.join(tryloHome(input.learning.homeDir, input.learning.env), "learning", "board"),
    workspaceId: workspaceIdentity(input.workspaceRoot), scope: input.workspaceRoot, turnId: input.turnId,
    provider: input.provider, model: input.model, now: () => new Date(input.nowMs ?? 0).toISOString(), emit: input.learning.emit,
    ...(input.method?.experience?.claimReview === undefined ? {} : { claimReview: () => input.method!.experience!.claimReview!() }) });
}

/** Thin host composition; each subsystem owns its hook and observation tool implementation. */
export function learningToolsOf(method: MethodBoard | undefined, tool: ToolGapRuntime | undefined, taskId: string | undefined): ToolPort | undefined {
  const methodTools = method?.experience === undefined || taskId === undefined ? undefined : createExperienceTools({ runtime: method.experience, taskId });
  const reportTools = taskId === undefined ? undefined : tool?.toolsForTask?.(taskId);
  return methodTools === undefined ? reportTools : reportTools === undefined ? methodTools : composeAdditionalTools(methodTools, reportTools);
}
