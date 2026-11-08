import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { Transcript } from "../../protocol/transcript.js";
import type { Envelope } from "../../protocol/envelope.js";
import { qualifySkillTasks as qualifyRawSkillTasks, skillDailyChecks } from "./skill-daily-checks.js";

const ROOT = testScratchPath("skill-check-fixture");
const FAMILY = { id: "json-report", intentClass: "normalize_report", checkKind: "acceptance", language: "json", checkSchema: "report-v1" };

function fixture() {
  const files = new Map([[path.join(ROOT, "check.mjs"), "assert.equal(actual, expected)"]]);
  files.set(path.join(ROOT, ".trylo", "skill-learning.json"), JSON.stringify({ schemaVersion: 1, checks: [
    { id: "report", label: "independent report checker", command: "node check.mjs", taskFamily: FAMILY, verifierFiles: ["check.mjs"] },
  ] }));
  return { files, reader: { readFile: (file: string) => files.get(file) } };
}

function transcript(command = "node check.mjs", outcome: "succeeded" | "failed" = "succeeded"): Transcript {
  return [{ sequence: 1, kind: "user", text: "make the report" },
    { sequence: 2, kind: "tool_call", name: "run_shell", toolCallId: "check-1", arguments: { command } },
    { sequence: 3, kind: "tool_result", name: "run_shell", toolCallId: "check-1", outcome, output: outcome === "succeeded" ? "actual checker result" : "shell_nonzero_exit:1\nactual checker result", truncated: false }];
}

function executedEvents(items: Transcript): Envelope[] {
  return items.flatMap(item => item.kind !== "tool_result" ? [] : [{ protocolVersion: "0.0", eventId: "actual-exit-" + item.toolCallId, sequence: item.sequence,
    timestamp: "2026-11-03T00:00:00.000Z", sessionId: "test-session", turnId: "test-turn", producerId: "execution", producerSequence: item.sequence, kind: "tool_result",
    payload: { toolCallId: item.toolCallId, status: item.outcome, ...(item.outcome === "succeeded" ? { value: { exitCode: 0 }, output: item.output, truncated: false } : { message: item.output }) } }]);
}

function qualifySkillTasks(...args: Parameters<typeof qualifyRawSkillTasks>) {
  return qualifyRawSkillTasks(args[0], args[1], args[2], args[3], args[4], args[5] ?? executedEvents(args[2]));
}

test("only the frozen independent foreground check qualifies an actual task", () => {
  const { reader } = fixture(), config = skillDailyChecks(reader, ROOT);

  assert.equal(qualifySkillTasks(reader, ROOT, transcript(), config.checks, 1)[0]?.qualification.outcome, "success");
  assert.equal(qualifySkillTasks(reader, ROOT, transcript("node other.mjs"), config.checks, 1).length, 0);
  assert.equal(qualifySkillTasks(reader, ROOT, transcript(), config.checks, 4).length, 0);
  const wrongDirectory = transcript().map(item => item.kind === "tool_call" ? { ...item, arguments: { ...item.arguments, cwd: "other" } } : item);

  assert.equal(qualifySkillTasks(reader, ROOT, wrongDirectory, config.checks, 1).length, 0);

  for (const effect of [{ pipeTo: { command: "node -e process.exit(0)" } }, { stdoutFile: "report.json" }]) {
    const changed = transcript().map(item => item.kind === "tool_call" ? { ...item, arguments: { ...item.arguments, ...effect } } : item);
    assert.equal(qualifySkillTasks(reader, ROOT, changed, config.checks, 1).length, 0);
  }
});

test("checker mutation and post-check writes invalidate a claimed pass", () => {
  const { reader, files } = fixture(), config = skillDailyChecks(reader, ROOT);
  const changed: Transcript = [...transcript(), { sequence: 4, kind: "tool_call", toolCallId: "write", name: "write_file", arguments: { path: "report.json", content: "wrong" } }];
  assert.equal(qualifySkillTasks(reader, ROOT, changed, config.checks, 1).length, 0);
  files.set(path.join(ROOT, "check.mjs"), "// removed every assertion");
  assert.equal(qualifySkillTasks(reader, ROOT, transcript(), config.checks, 1).length, 0);
  assert.notEqual(skillDailyChecks(reader, ROOT).checks[0]?.taskFamily.checkSchema, config.checks[0]?.taskFamily.checkSchema);
});

test("a failed real check remains negative evidence and completion alone produces none", () => {
  const { reader } = fixture(), config = skillDailyChecks(reader, ROOT);
  assert.equal(qualifySkillTasks(reader, ROOT, transcript("node check.mjs", "failed"), config.checks, 1)[0]?.qualification.outcome, "failure");
  assert.deepEqual(qualifySkillTasks(reader, ROOT, [{ kind: "assistant_text", sequence: 1, blockId: "a", text: "completed" }], config.checks, 1), []);
});

test("check paths must stay inside the actual workspace", () => {
  const { reader, files } = fixture();
  files.set(path.join(ROOT, ".trylo", "skill-learning.json"), JSON.stringify({ schemaVersion: 1, checks: [{ id: "x", label: "x", command: "node check.mjs", taskFamily: FAMILY, verifierFiles: ["../outside"] }] }));
  assert.throws(() => skillDailyChecks(reader, ROOT), /outside_workspace/);
});

test("a real sandbox readiness refusal did not execute the checker and is not an external failure", () => {
  const { reader } = fixture(), config = skillDailyChecks(reader, ROOT);
  // Reduced from sequence-09-01/train-1 actual canonical tool failure. No
  // process was started, so this is not a failed assertion in the report.
  const message = 'isolation_broken:command "node": command was not run; the sandbox readiness probe failed: srt-win status timed out after 15000ms (killed by SIGTERM)';
  const items: Transcript = transcript("node check.mjs", "failed").map(item => item.kind === "tool_result" ? { ...item, output: message } : item);
  const event: Envelope = { protocolVersion: "0.0", eventId: "real-unstarted-check", sequence: 1, timestamp: "2026-11-03T00:00:00.000Z", sessionId: "actual-session", turnId: "actual-turn", producerId: "execution", producerSequence: 1,
    kind: "tool_result", payload: { toolCallId: "check-1", status: "failed", code: "isolation_broken", message } };

  assert.deepEqual(qualifySkillTasks(reader, ROOT, items, config.checks, 1, [event]), []);
});

test("missing or conflicting canonical termination metadata cannot grant success", () => {
  const { reader } = fixture(), config = skillDailyChecks(reader, ROOT), items = transcript();
  assert.deepEqual(qualifyRawSkillTasks(reader, ROOT, items, config.checks, 1), []);
  const events = executedEvents(items), event = events[0]!;
  for (const payload of [{ ...event.payload, value: { exitCode: 1 } }, { ...event.payload, value: {} }, { ...event.payload, output: "other call" }]) {
    assert.deepEqual(qualifyRawSkillTasks(reader, ROOT, items, config.checks, 1, [{ ...event, payload }]), []);
  }
});

for (const prefix of ["permission_denied", "permission_unknown", "shell_timeout", "shell_nonzero_exit:-1", "shell_nonzero_exit:0"]) {
  test(`${prefix} is not a completed independent checker failure`, () => {
    const { reader } = fixture(), config = skillDailyChecks(reader, ROOT);
    const items = transcript("node check.mjs", "failed").map(item => item.kind === "tool_result" ? { ...item, output: prefix + "\nnot run to a known assertion exit" } : item);
    assert.deepEqual(qualifySkillTasks(reader, ROOT, items, config.checks, 1), []);
  });
}
