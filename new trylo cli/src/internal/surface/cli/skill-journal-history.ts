import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BoardState } from "../../learning/control/state.js";
import { parseEnvelope } from "../../protocol/validate.js";
import type { Envelope } from "../../protocol/envelope.js";
import { isTranscriptItem, type TranscriptItem } from "../../protocol/transcript.js";
import type { CliContext } from "./context.js";
import { isValidSessionId, sessionsDir, SESSION_FILE_SUFFIX, sessionPath } from "./session-paths.js";
import { skillJournalUses, type SkillJournalUse } from "./skill-journal-usage.js";

/** Read the canonical journals; no second usage ledger or receipt can mint a load. */
export async function readSkillJournalUses(ctx: Pick<CliContext, "homeDir" | "env" | "cwd">, state: BoardState, workspaceId: string): Promise<readonly SkillJournalUse[]> {
  const directory = sessionsDir(ctx.homeDir, ctx.env);
  let names: string[];

  try { names = await readdir(directory); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw new Error("skill_usage_history_unavailable");
  }

  const entries = [];

  for (const name of names.filter(name => name.endsWith(SESSION_FILE_SUFFIX))) {
    const info = await stat(path.join(directory, name));
    if (!info.isFile()) throw new Error("skill_usage_history_invalid");
    entries.push({ name, bytes: info.size });
  }

  if (entries.length > 10_000 || entries.reduce((sum, item) => sum + item.bytes, 0) > 64 * 1024 * 1024) throw new Error("skill_usage_history_limit");

  const uses: SkillJournalUse[] = [];

  for (const entry of entries) {
    const sessionId = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
    if (!isValidSessionId(sessionId)) continue;

    const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });
    const recovered = await store.read();
    if (!recovered.ok || recovered.session.repairedTornTail) throw new Error("skill_usage_history_unavailable");

    if (recovered.session.fingerprint.workspaceId !== workspaceId) continue;

    const recorded = await store.readRecords();
    if (!recorded.ok || recorded.view.tornTail) throw new Error("skill_usage_history_unavailable");

    const turns = new Map<string, { transcript: TranscriptItem[]; events: Envelope[] }>();

    for (const item of recorded.view.records) {
      if (!item.turnId) continue;

      const turn = turns.get(item.turnId) ?? { transcript: [], events: [] };
      turns.set(item.turnId, turn);

      if (item.type === "transcript_item") {
        if (!isTranscriptItem(item.payload)) throw new Error("skill_usage_history_invalid");
        turn.transcript.push(item.payload);
      } else if (item.type === "envelope") {
        const parsed = parseEnvelope(item.payload.envelope);
        if (!parsed.ok || parsed.envelope.sessionId !== sessionId || parsed.envelope.turnId !== item.turnId) throw new Error("skill_usage_history_invalid");
        turn.events.push(parsed.envelope);
      }
    }

    for (const [turnId, turn] of turns) uses.push(...skillJournalUses({ state, workspaceId, contentRoot: ctx.cwd, sessionId, turnId, ...turn }));
  }

  return uses;
}
