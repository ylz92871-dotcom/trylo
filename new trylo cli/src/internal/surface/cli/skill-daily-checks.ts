import path from "node:path";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { parseSkillTaskFamily } from "../../learning/domains/skill/conditions.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";
import type { Transcript, TranscriptItem } from "../../protocol/transcript.js";
import type { SkillTaskQualification } from "../../integration/skill-learning/task-contract.js";
import type { Envelope } from "../../protocol/envelope.js";
import { isMutatingTool } from "../../adapters/tools/mutating/names.js";
import { actualSkillCheckExit } from "./skill-daily-check-exit.js";

export type SkillDailyCheck = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly taskFamily: TaskFamily;
  readonly verifierFiles: Readonly<Record<string, string>>;
  readonly replay?: { readonly task: string; readonly files: readonly string[] };
};

export type SkillDailyConfiguration = {
  readonly checks: readonly SkillDailyCheck[];
  readonly allowance: { readonly maxTokens: number; readonly maxCalls: number };
};

type Reader = { readonly readFile: (file: string) => string | undefined };

/** A task owner's existing checker is frozen before execution, never invented by a learner. */
export function skillDailyChecks(reader: Reader, workspaceRoot: string): SkillDailyConfiguration {
  const text = reader.readFile(path.join(workspaceRoot, ".trylo", "skill-learning.json"));
  if (text === undefined) return { checks: [], allowance: { maxTokens: 12000, maxCalls: 12 } };

  const value: unknown = JSON.parse(text);
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.checks) || value.checks.length > 16) throw new Error("skill_check_config_invalid");

  const checks = value.checks.map(item => parseCheck(reader, workspaceRoot, item));
  if (new Set(checks.map(item => item.id)).size !== checks.length) throw new Error("skill_check_config_duplicate");

  const allowance = value.allowance;
  if (allowance === undefined) return { checks, allowance: { maxTokens: 12000, maxCalls: 12 } };

  if (!record(allowance) || !integer(allowance.maxTokens, 1, 100_000) || !integer(allowance.maxCalls, 1, 16)) throw new Error("skill_allowance_invalid");

  return { checks, allowance: { maxTokens: allowance.maxTokens, maxCalls: allowance.maxCalls } };
}

function parseCheck(reader: Reader, root: string, value: unknown): SkillDailyCheck {
  if (!record(value) || !text(value.id) || !text(value.label) || !text(value.command)
    || !strings(value.verifierFiles) || value.verifierFiles.length === 0 || value.verifierFiles.length > 32) throw new Error("skill_check_invalid");

  const family = parseSkillTaskFamily(value.taskFamily);
  if (!family.ok) throw new Error("skill_check_family_invalid");

  const verifierFiles: Record<string, string> = {};

  for (const relative of value.verifierFiles) {
    const content = reader.readFile(workspaceFile(root, relative));
    if (content === undefined || Buffer.byteLength(content, "utf8") > 262_144) throw new Error("skill_verifier_unavailable");
    verifierFiles[relative] = sha256Hex(content);
  }

  const checkSchema = `${family.value.checkSchema ?? value.id}:${contentHashOf({ command: value.command, verifierFiles }).slice(0, 20)}`;
  let replay: SkillDailyCheck["replay"];
  if (value.replay !== undefined) {
    if (!record(value.replay) || !text(value.replay.task) || !strings(value.replay.files) || value.replay.files.length > 64) throw new Error("skill_replay_invalid");
    for (const relative of value.replay.files) workspaceFile(root, relative);
    replay = { task: value.replay.task, files: value.replay.files };
  }

  return { id: value.id, label: value.label, command: value.command, taskFamily: { ...family.value, checkSchema }, verifierFiles,
    ...(replay === undefined ? {} : { replay }) };
}

export type QualifiedSkillTask = {
  readonly check: SkillDailyCheck;
  readonly qualification: SkillTaskQualification;
  readonly transcript: Transcript;
  readonly sourceSequence: number;
};

/** Exact approved foreground call + terminal outcome + unchanged checker; no completed=>pass. */
export function qualifySkillTasks(reader: Reader, root: string, transcript: Transcript, checks: readonly SkillDailyCheck[], fromSequence: number, events?: readonly Envelope[]): readonly QualifiedSkillTask[] {
  const current = transcript.filter(item => item.sequence >= fromSequence);
  const found: QualifiedSkillTask[] = [];

  for (const check of checks) {
    if (Object.entries(check.verifierFiles).some(([file, hash]) => {
      const content = reader.readFile(workspaceFile(root, file));
      return content === undefined || sha256Hex(content) !== hash;
    })) continue;
    for (const item of current) {
      if (item.kind !== "tool_call" || item.name !== "run_shell" || item.arguments.command !== check.command
        || item.arguments.runInBackground === true || item.arguments.steps !== undefined) continue;

      if (Object.keys(item.arguments).some(key => !["command", "cwd", "timeoutMs", "runInBackground"].includes(key))) continue;

      const cwd = item.arguments.cwd;
      if (cwd !== undefined && (typeof cwd !== "string" || path.relative(path.resolve(root), path.resolve(root, cwd)) !== "")) continue;

      const outcome = current.find(result => result.kind === "tool_result" && result.toolCallId === item.toolCallId && result.sequence > item.sequence);
      if (outcome?.kind !== "tool_result" || outcome.truncated || (outcome.outcome !== "succeeded" && outcome.outcome !== "failed")) continue;

      const sourceEvents = events?.filter(event => event.kind === "tool_result" && event.payload.toolCallId === item.toolCallId);
      const sourceEvent = sourceEvents?.[0];
      if (sourceEvents?.length !== 1 || actualSkillCheckExit(outcome, sourceEvent) === undefined) continue;

      if (outcome.outcome === "succeeded" && current.some(later => later.sequence > outcome.sequence && isMutation(later))) continue;

      found.push({ check, sourceSequence: outcome.sequence, transcript: transcript.filter(record => record.sequence <= outcome.sequence),
        qualification: { kind: "external_check", ref: skillDailyCheckRef(item.toolCallId), outcome: outcome.outcome === "succeeded" ? "success" : "failure",
          checks: [{ label: check.label, eventId: sourceEvent?.eventId ?? item.toolCallId }] } });
    }
  }

  // Retain a failure and the last successful opportunity per check; repeated
  // invocations in one run never become independent successful demonstrations.
  return checks.flatMap(check => {
    const items = found.filter(item => item.check.id === check.id);
    const failed = items.find(item => item.qualification.outcome === "failure");
    const succeeded = items.filter(item => item.qualification.outcome === "success").at(-1);
    return [...(failed === undefined ? [] : [failed]), ...(succeeded === undefined ? [] : [succeeded])];
  });
}

export function skillDailyCheckRef(toolCallId: string): string { return `execution:check:${toolCallId}`; }

function isMutation(item: TranscriptItem): boolean {
  return item.kind === "tool_call" && isMutatingTool(item.name);
}

export function workspaceFile(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("skill_path_outside_workspace");
  const file = path.resolve(root, relative), inside = path.relative(path.resolve(root), file);
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("skill_path_outside_workspace");
  return file;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }

function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
