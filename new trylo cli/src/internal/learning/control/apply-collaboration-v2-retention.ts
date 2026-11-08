import type { BoardCommand } from "./commands.js";
import type { BoardState } from "./state.js";
import { fail, nextSeq, replay, succeed, type ReduceResult } from "./result.js";
import { contentHashOf } from "./hash.js";
import { methodPayloadHash } from "./method-replay.js";
import { compactCollaborationProjectionV2, factPositionsV2 } from "../domains/collaboration/v2-retention.js";
import { isCollaborationV2Fact } from "../domains/collaboration/v2-parse.js";
import { validCollaborationV2Facts } from "./apply-collaboration-v2.js";

export function applyCompactCollaborationV2(state: BoardState, command: Extract<BoardCommand, { type: "compact_collaboration_v2" }>): ReduceResult {
  if (command.expectedSequence !== state.sequence) return fail(state, "collaboration_fact_conflict", "retention_watermark_changed");

  const compacted = compactCollaborationProjectionV2(state, command.scope, command.issuedAt);
  if (compacted === undefined) return replay(state);

  return succeed(state, command.commandId, [{ type: "collaboration_v2_compacted", sequence: nextSeq(state), commandId: command.commandId,
    occurredAt: command.issuedAt, archive: compacted.archive, archivedFacts: compacted.removed }], {
    collaborationV2Facts: compacted.facts, collaborationV2Archives: compacted.archives,
  });
}

export function applyRehydrateCollaborationV2(state: BoardState, command: Extract<BoardCommand, { type: "rehydrate_collaboration_v2" }>): ReduceResult {
  if (!Array.isArray(command.records) || command.records.length > 8192) return fail(state, "invalid_collaboration_fact", "archive_hydration_size");

  const facts = new Map((state.collaborationV2Facts ?? []).map(f => [f.factId, f]));
  const restored: string[] = [];

  for (const record of command.records) {
    if (record.type !== "record_collaboration_v2" || !isCollaborationV2Fact(record.fact) || record.fact.scope !== command.scope
      || record.commandId !== `collaboration-v2:${record.fact.factId}`) return fail(state, "invalid_collaboration_fact", "archive_record_shape");

    const identity = state.appliedCommands.find(c => c.commandId === record.commandId);
    if (identity?.payloadHash === undefined || identity.payloadHash !== methodPayloadHash(record)) return fail(state, "command_payload_conflict", record.commandId);

    const present = facts.get(record.fact.factId);
    if (present !== undefined && contentHashOf(present) !== contentHashOf(record.fact)) return fail(state, "collaboration_fact_conflict", record.fact.factId);

    if (present === undefined) {
      facts.set(record.fact.factId, record.fact);
      restored.push(record.fact.factId);
    }
  }

  if (restored.length === 0) return replay(state);

  const positions = factPositionsV2(state);
  const merged = [...facts.values()].sort((a, b) => (positions.get(a.factId) ?? 0) - (positions.get(b.factId) ?? 0));
  if (!validCollaborationV2Facts(state, merged)) return fail(state, "collaboration_reference_invalid", "archive_closure_incomplete");

  return succeed(state, command.commandId, [{ type: "collaboration_v2_rehydrated", sequence: nextSeq(state), commandId: command.commandId,
    occurredAt: command.issuedAt, scope: command.scope, factIds: restored }], { collaborationV2Facts: merged });
}
