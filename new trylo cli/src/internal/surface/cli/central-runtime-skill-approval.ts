import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { skillApprovalDraft } from "../../learning/agent/subsystems/skill/index.js";
import type { StoreLoadResult } from "../../learning/control/store-port.js";
import { notifyCentralRuntimeForSource, type CentralRuntimeSourceNotificationResult } from "./central-runtime-notify.js";
import type { CliContext } from "./context.js";
import { hermesSkillLifecycle } from "./hermes-skill-lifecycle.js";
import { tryloHome } from "./session-paths.js";

export type CentralRuntimeSkillApprovalInput = Omit<Parameters<typeof skillApprovalDraft>[0], "board">;

export type CentralRuntimeSkillApprovalPorts = {
  readonly recordApproval: (input: CentralRuntimeSkillApprovalInput) => Promise<void>;
  readonly loadBoard: () => Promise<StoreLoadResult>;
  readonly notify: typeof notifyCentralRuntimeForSource;
};

function originalPorts(ctx: CliContext): CentralRuntimeSkillApprovalPorts {
  const boardRoot = path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "board");
  return { recordApproval: input => hermesSkillLifecycle(boardRoot, () => true).recordApproval(input),
    loadBoard: () => createBoardReader(boardRoot).load(), notify: notifyCentralRuntimeForSource };
}

/** Only the original persisted approval fact supplies a scope and wake identity. The native transaction is never repeated. */
export async function observeCentralRuntimeSkillApproval(ctx: CliContext, input: CentralRuntimeSkillApprovalInput,
  ports: CentralRuntimeSkillApprovalPorts = originalPorts(ctx)): Promise<CentralRuntimeSourceNotificationResult> {
  await ports.recordApproval(input);
  const loaded = await ports.loadBoard();
  if (!loaded.ok) return loaded;
  const draft = skillApprovalDraft({ ...input, board: loaded.state });
  if (draft === undefined) return { ok: true, notified: false };
  if (!loaded.state.rewardV2Facts?.some(fact => fact.id === draft.id)) return { ok: false, reason: "skill_approval_source_unavailable" };
  return ports.notify(ctx, { workspaceRoot: draft.scope, reason: "skill_native_approval_committed", sourceRefs: [draft.id] });
}
