import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import { skillExperience } from "../experience.js";
import { delegatedTaskExperiences } from "./delegated-experience.js";
import { priorSkillHints } from "./prior-skill-hints.js";
import { journalDelegatedTasks, journalExperiencePrefix, journalSourceStart, type JournalExperienceSource } from "./journal-delegation.js";
import { journalSourceContext } from "./journal-source-context.js";
import type { SkillSourceContext } from "../contracts.js";

export type JournalSkillExperience = { readonly experience: JsonObject; readonly priorLoadedSkills: readonly string[];
  readonly priorProvidedSkills: readonly string[]; readonly sourceContext: SkillSourceContext };

const names = (experience: JsonObject): readonly string[] => Array.isArray(experience.loadedSkills)
  ? experience.loadedSkills.filter((value): value is string => typeof value === "string") : [];

function childNames(children: readonly JsonObject[]): readonly string[] {
  return children.flatMap(child => child.experience !== null && typeof child.experience === "object" && !Array.isArray(child.experience)
    ? names(child.experience as JsonObject) : []);
}

function childProvidedNames(children: readonly JsonObject[]): readonly string[] {
  return children.flatMap(child => Array.isArray(child.providedSkills) ? child.providedSkills.flatMap(value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const skill = value as JsonObject;
    return typeof skill.name === "string" ? [skill.name] : [];
  }) : []);
}

/** One combined transport budget; chronological omission never chooses a lesson. */
export function journalSkillExperience(input: {
  readonly records: readonly SessionRecord[]; readonly history: Transcript; readonly source: JournalExperienceSource;
  readonly terminal?: JsonObject; readonly maxChars?: number;
}): JournalSkillExperience {
  const maxChars = input.maxChars ?? 40_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 2048 || maxChars > 40_000) throw new Error("hermes_experience_budget_invalid");

  const records = journalExperiencePrefix(input.records, input.source), start = journalSourceStart(records, input.source);
  const historySequences = new Set(records.filter(record => record.type === "transcript_item").map(record => record.payload.sequence));
  const history = input.history.filter(item => historySequences.has(item.sequence));
  const priorRecords = records.filter(record => record.sequence < start);
  const priorSequences = new Set(priorRecords.filter(record => record.type === "transcript_item").map(record => record.payload.sequence));
  const priorHistory = history.filter(item => priorSequences.has(item.sequence));
  const tasks = journalDelegatedTasks(records, history), priorTasks = journalDelegatedTasks(priorRecords, priorHistory);
  const priorChildren = delegatedTaskExperiences(priorRecords, input.source.sessionId, priorTasks);
  const priorLoadedSkills = [...new Set([...names(skillExperience(priorHistory)), ...childNames(priorChildren)])].slice(-32);
  const priorProvidedSkills = [...new Set(childProvidedNames(priorChildren))].slice(-32);
  const children = [...delegatedTaskExperiences(records, input.source.sessionId, tasks)];
  const totalChildren = children.length;
  let terminal: JsonObject = input.terminal === undefined ? {} : { terminal: input.terminal };
  const childFields = (retained: readonly JsonObject[] = children): JsonObject => ({ delegatedTasks: retained, omittedDelegatedTasks: totalChildren - retained.length,
    delegatedTasksTruncated: retained.length < totalChildren,
    delegatedTasksInterpretation: "Observed same-session delegated execution, separately namespaced. Checkpoints and tool results do not prove task quality or permission." });
  const childMinimum = totalChildren === 0 ? {} : childFields([]);
  const minimalSource = { sourceContext: { currentUserAttribution: "not_recorded" } };
  if (JSON.stringify({ ...terminal, ...childMinimum, ...minimalSource }).length > maxChars - 1023) {
    // Omit over-budget terminal detail explicitly, never shorten it into a
    // different execution fact or displace the source attribution/parent minimum.
    terminal = { terminalOmitted: true, terminalOmissionReason: "transport_budget" };
  }

  // Reserve the parent minimum and child omission facts before source metadata;
  // current attribution takes precedence over lists, explanations and prior hints.
  const sourceOverhead = JSON.stringify({ ...terminal, ...childMinimum, sourceContext: {} }).length - 2;
  const sourceContext = journalSourceContext({ records, history, source: input.source,
    maxChars: Math.min(2000, maxChars - 1023 - sourceOverhead) });
  const fixed = { ...terminal, sourceContext };
  const hintBudget = Math.min(4000, Math.max(0, maxChars - 1024 - JSON.stringify({ ...fixed, ...childMinimum }).length));
  const permanent = { ...fixed, ...priorSkillHints(priorLoadedSkills, priorProvidedSkills, hintBudget) };

  if (totalChildren === 0) {
    const overhead = JSON.stringify(permanent).length - 1;
    return { experience: { ...skillExperience(history, maxChars - overhead), ...permanent }, priorLoadedSkills, priorProvidedSkills, sourceContext };
  }

  const childBudget = Math.min(16_000, maxChars - 1023 - JSON.stringify(permanent).length + 1);

  while (children.length > 0 && JSON.stringify(childFields()).length > childBudget) children.shift();

  const extras = { ...permanent, ...childFields() };
  const parentBudget = maxChars - JSON.stringify(extras).length + 1;

  return { experience: { ...skillExperience(history, parentBudget), ...extras }, priorLoadedSkills, priorProvidedSkills, sourceContext };
}
