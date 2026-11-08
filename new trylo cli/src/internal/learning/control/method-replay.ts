import type { BoardCommand } from "./commands.js";
import { contentHashOf } from "./hash.js";
import { fail, replay, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";

/** Method write identity excludes observation time: a retry may carry a new clock stamp. */
export function methodPayloadHash(command: BoardCommand): string | undefined {
  if (command.type === "start_job" && command.continuation !== undefined) {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_method_experience") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_collaboration_runtime") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "coordinate_learning") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_learning_grant_fact") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "compact_collaboration_v2" || command.type === "rehydrate_collaboration_v2") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_collaboration_v2") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_collaboration_fact") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type === "record_tool_use" || command.type === "requeue_job") {
    const { issuedAt: _at, ...payload } = command;
    return contentHashOf(payload);
  }

  if (command.type !== "record_method_fielding" && command.type !== "record_method_feedback" &&
      command.type !== "set_method_retention" && command.type !== "record_reward_exposure" &&
      command.type !== "record_reward_feedback" && command.type !== "record_tool_trial" && command.type !== 'record_reward_v2_fact') return undefined;

  const { issuedAt: _at, ...payload } = command;

  return contentHashOf(payload);
}

export function replayMethodCommand(state: BoardState, command: BoardCommand): ReduceResult {
  const applied = state.appliedCommands.find(item => item.commandId === command.commandId);
  const digest = methodPayloadHash(command);
  if (digest === undefined) return applied?.payloadHash === undefined
    ? replay(state) : fail(state, "command_payload_conflict", command.commandId);

  if (applied?.payloadHash !== undefined) {
    return applied.payloadHash === digest ? replay(state) : fail(state, "command_payload_conflict", command.commandId);
  }

  // Old compacted snapshots do not retain a command-to-payload relation. A
  // matching fact somewhere else cannot prove what this commandId originally
  // meant. Reads and fresh writes still work; an unprovable retry is refused.
  return fail(state, "command_identity_unavailable", command.commandId);
}

/** The original append log can restore identity missing from a legacy snapshot. */
export function recoverMethodCommandIdentities(state: BoardState, commands: ReadonlyArray<BoardCommand>): BoardState {
  const missing = new Set(state.appliedCommands.filter(item => item.payloadHash === undefined).map(item => item.commandId));
  if (missing.size === 0) return state;

  const hashes = new Map<string, string | undefined>();

  for (const command of commands) {
    // Preserve log order, including an unhashable final occurrence of the same ID.
    if (missing.has(command.commandId)) hashes.set(command.commandId, methodPayloadHash(command));
  }

  return { ...state, appliedCommands: state.appliedCommands.map(item => {
    const payloadHash = hashes.get(item.commandId);
    return item.payloadHash === undefined && payloadHash !== undefined ? { ...item, payloadHash } : item;
  }) };
}
