import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import { readSkillJournalUses } from "./skill-journal-history.js";

test("only a genuinely absent journal directory means no usage; unreadable inventory cannot claim zero", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-skill-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { cwd: root, homeDir: root, env: { TRYLO_HOME: root } };
  assert.deepEqual(await readSkillJournalUses(ctx, emptyBoardState(), "workspace"), []);
  await writeFile(path.join(root, "sessions"), "not a readable session directory");
  await assert.rejects(readSkillJournalUses(ctx, emptyBoardState(), "workspace"), /skill_usage_history_unavailable/);
});
