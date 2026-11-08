import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolingEvent } from "../../../../../../tooling/contract/types.js";

export type StoredEvent = {
  readonly sequence: number;
  readonly checksum: string;
  readonly event: ToolingEvent;
};

function checksumOf(sequence: number, event: ToolingEvent): string {
  return createHash("sha256")
    .update(JSON.stringify({ sequence, event }))
    .digest("hex");
}

export { createMemoryLog } from "../../assets/events/memory-log.js";

export async function appendEventFile(
  filePath: string,
  event: ToolingEvent,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const stored: StoredEvent = {
    sequence: event.sequence,
    checksum: checksumOf(event.sequence, event),
    event,
  };

  await appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8");
}

export async function loadEventFile(
  filePath: string,
): Promise<Result<readonly ToolingEvent[], "corrupt_log" | "empty_log">> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return err("empty_log", "event log missing");
  }

  const events: ToolingEvent[] = [];
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return err("empty_log", "event log empty");
  }

  for (const line of lines) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return err("corrupt_log", "event log JSON corrupt");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("sequence" in parsed) ||
      !("checksum" in parsed) ||
      !("event" in parsed)
    ) {
      return err("corrupt_log", "event log shape corrupt");
    }

    const stored = parsed as StoredEvent;
    const expected = checksumOf(stored.sequence, stored.event);
    if (expected !== stored.checksum) {
      return err("corrupt_log", "event log checksum mismatch");
    }

    events.push(stored.event);
  }

  return ok(events);
}
