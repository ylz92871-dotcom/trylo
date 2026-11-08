import type { JsonObject } from "../protocol/envelope.js";
import { TOOL_FILE_WRITE_KEY, type ToolFileWriteEffect } from "../ports/tools.js";

/**
 * Turning a successful tool into a durable fact.
 *
 * "The tool succeeded" is not the same claim as "these bytes landed at this
 * path". The journal's `file_write` kind exists for the second one, and it is
 * derived here from what the tool reported rather than from what it was asked
 * to do, so a tool that quietly did something else cannot claim otherwise.
 */

const WRITE_MODES = new Set(["created", "overwritten", "patched", "deleted", "moved"]);

export type FileWriteRecord = {
  readonly toolCallId: string;
  readonly tool: string;
  readonly effect: ToolFileWriteEffect;
};

function isEffect(value: unknown): value is ToolFileWriteEffect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Readonly<Record<string, unknown>>;

  return (
    record.kind === "file_write" &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.bytes === "number" &&
    typeof record.mode === "string" &&
    WRITE_MODES.has(record.mode)
  );
}

/**
 * One tool call, every file it changed. Single-file tools report `fileWrite`;
 * a multi-file patch reports `fileWrites`. Both shapes stay accepted so the
 * older tools keep their contract byte for byte.
 */
export function readFileWriteRecords(toolCallId: string, tool: string, value: JsonObject): FileWriteRecord[] {
  const batch = value["fileWrites"];
  if (Array.isArray(batch)) {
    return batch.flatMap((entry) => (isEffect(entry) ? [{ toolCallId, tool, effect: entry }] : []));
  }
  const record = readFileWriteRecord(toolCallId, tool, value);
  return record === undefined ? [] : [record];
}

export function readFileWriteRecord(
  toolCallId: string,
  tool: string,
  value: JsonObject,
): FileWriteRecord | undefined {
  const candidate = value[TOOL_FILE_WRITE_KEY];
  if (!isEffect(candidate)) {
    return undefined;
  }
  return { toolCallId, tool, effect: candidate };
}

/**
 * Emits the `file_write` facts from what the tool reported it did. Staying here
 * keeps `runner.ts` from growing a second responsibility it does not need.
 * A multi-file patch emits one fact per file, in patch order.
 */
export function emitFileWriteRecord(
  emit: (kind: string, payload: JsonObject) => void,
  toolCallId: string,
  tool: string,
  value: JsonObject,
): void {
  for (const record of readFileWriteRecords(toolCallId, tool, value)) {
    emit("file_write", {
      toolCallId,
      tool: record.tool,
      path: record.effect.path,
      bytes: record.effect.bytes,
      mode: record.effect.mode,
    });
  }
}
