import type { BoardCommand } from "./commands.js";
import type { BoardState } from "./state.js";
import { contentHashOf } from "./hash.js";
import { fail, nextSeq, succeed, replay, type ReduceResult } from "./result.js";
import { isToolUseRecord, MAX_TOOL_USES } from "../domains/tool/evolution/use.js";

export function applyToolUse(state: BoardState, command: Extract<BoardCommand, { type: "record_tool_use" }>): ReduceResult {
  const record = command.record;
  if (!isToolUseRecord(record)) return fail(state, "invalid_tool_use", "malformed use fact");
  const prior = (state.toolUses ?? []).find(item => item.useId === record.useId);
  if (prior !== undefined) return contentHashOf(prior) === contentHashOf(record) ? replay(state) : fail(state, "tool_use_conflict", record.useId);
  if ((state.toolUses?.length ?? 0) >= MAX_TOOL_USES) return fail(state, "tool_use_capacity", record.useId);
  const asset = state.assets.find(item => item.versionId === record.versionId);
  if (asset === undefined) return fail(state, "asset_not_found", record.versionId);
  if (asset.kind !== "tool_package" || asset.scope !== record.scope || asset.contentHash !== record.contentHash
    || contentHashOf(asset.content) !== record.contentHash) return fail(state, "invalid_tool_use", "fact does not bind archived content and scope");
  // A terminal fact remains recordable if a proposal was retired during an
  // already-running invocation. Retirement prevents the next launch, not history.
  return succeed(state, command.commandId, [{ type: "tool_use_recorded", commandId: command.commandId,
    sequence: nextSeq(state), occurredAt: command.issuedAt, record }], { toolUses: [...(state.toolUses ?? []), record] });
}
