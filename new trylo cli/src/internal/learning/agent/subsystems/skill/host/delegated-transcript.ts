import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { Transcript, TranscriptItem } from "../../../../../protocol/transcript.js";
import { toolCallIndexByResult } from "../../../../../protocol/tool-pairing.js";
import { skillExperience } from "../experience.js";

/** Reuse native instruction-read classification while preserving repeated call occurrences. */
export function delegatedTranscriptExperience(transcript: Transcript, maxChars: number): JsonObject {
  const paired = toolCallIndexByResult(transcript);
  // Every physical child execution prepends private role instructions to its
  // initial user item, including resumed executions in the carried history.
  // Actual assignments/follow-ups remain visible in the parent tool arguments.
  const projected: TranscriptItem[] = transcript.filter(item => item.kind === "assistant_text");
  const omittedRuntimeComposedInputs = transcript.filter(item => item.kind === "user").length;
  const inputFacts = { omittedRuntimeComposedInputs,
    inputInterpretation: "Child user items may contain runtime-composed role instructions and are withheld. Actual parent assignments and follow-ups remain in the parent canonical tool-call arguments." };
  const originalIds = new Map<string, string>();

  for (const [resultIndex, callIndex] of paired) {
    const call = transcript[callIndex], result = transcript[resultIndex];
    if (call?.kind !== "tool_call" || result?.kind !== "tool_result" || call.name !== result.name) continue;

    // Internal pairing keys never escape. Real ids + local sequences remain
    // scoped by the surrounding delegated-task namespace in the result.
    const key = `child-exchange-${callIndex}-${resultIndex}`;

    originalIds.set(key, call.toolCallId);
    projected.push({ ...call, toolCallId: key }, { ...result, toolCallId: key });
  }

  projected.sort((a, b) => a.sequence - b.sequence);
  const overhead = JSON.stringify(inputFacts).length - 1;
  const experience = skillExperience(projected, Math.max(1024, maxChars - overhead));
  const restoreId = (value: unknown): JsonObject | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    // Values come from skillExperience's own JSON output, not persisted casts.
    const item = value as JsonObject;
    const id = typeof item.toolCallId === "string" ? originalIds.get(item.toolCallId) : undefined;
    return id === undefined ? item : { ...item, toolCallId: id };
  };
  const restoredObjects = (values: readonly unknown[]): JsonObject[] => values.flatMap<JsonObject>(value => {
    const restored = restoreId(value);
    return restored === undefined ? [] : [restored];
  });
  const messages = Array.isArray(experience.messages) ? restoredObjects(experience.messages) : [];
  const reads = Array.isArray(experience.skillReads) ? restoredObjects(experience.skillReads) : [];
  const skillReads = reads.filter(item => typeof item.toolCallId === "string" && item.toolCallId.length <= 256);
  const loadedSkills = Array.isArray(experience.loadedSkills) ? [...experience.loadedSkills] : [];
  let omittedEntries = Number(experience.omittedEntries ?? 0);
  let omittedSkillReads = Number(experience.omittedSkillReads ?? 0) + reads.length - skillReads.length;
  let truncated = experience.truncated === true || reads.length !== skillReads.length;
  const result = (): JsonObject => ({ ...experience, ...inputFacts, messages, skillReads, loadedSkills, omittedEntries, omittedSkillReads, truncated });

  // Restoring real ids can enlarge the bounded native projection. Keep the
  // same chronological transport omissions, without selecting semantic value.
  while (JSON.stringify(result()).length > maxChars) {
    if (messages.length > 0) {
      messages.shift();
      omittedEntries++;
    }
    else if (skillReads.length > 0) {
      skillReads.shift();
      omittedSkillReads++;
    }
    else if (loadedSkills.length > 0) loadedSkills.shift();
    else break;
    truncated = true;
  }

  return result();
}
