import type { Transcript } from "../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../protocol/envelope.js";
import { hermesSkillRead, MAX_HERMES_SKILL_READ_FACTS } from "./skill-read.js";
import { toolCallIndexByResult } from "../../../../protocol/tool-pairing.js";

const MAX_SKILL_READ_CALL_ID_CHARS = 256;

/** Hermes reviews visible conversation history. Tool exchanges remain causally paired. */
export function skillExperience(transcript: Transcript, maxChars = 40_000): JsonObject {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1024 || maxChars > 48_000) throw new Error("hermes_experience_budget_invalid");

  const calls = toolCallIndexByResult(transcript);
  const visible: JsonObject[] = [];
  const loaded = new Set<string>();
  const skillReads: JsonObject[] = [];
  let omittedSkillReads = 0;
  let clipped = false;

  for (const [index, item] of transcript.entries()) {
    if (item.kind === "user" || item.kind === "assistant_text") {
      visible.push({ sequence: item.sequence, role: item.kind === "user" ? "user" : "assistant", text: item.text.slice(0, 8000) });
      if (item.text.length > 8000) clipped = true;
    } else if (item.kind === "tool_result") {
      const call = transcript[calls.get(index) ?? -1];
      if (call?.kind !== "tool_call" || call.name !== item.name) continue; // Never borrow a future or differently named call.

      const args = JSON.stringify(call.arguments);

      visible.push({ sequence: call.sequence, role: "tool_exchange", toolCallId: item.toolCallId, name: item.name,
        arguments: args.slice(0, 4000), outcome: item.outcome, output: item.output.slice(0, 8000),
        truncated: item.truncated || args.length > 4000 || item.output.length > 8000 });

      if (args.length > 4000 || item.output.length > 8000 || item.truncated) clipped = true;

      const skill = item.outcome === "succeeded" && !item.truncated ? hermesSkillRead(call, item.output) : undefined;
      if (skill !== undefined) {
        loaded.delete(skill.name);
        loaded.add(skill.name);

        if (loaded.size > MAX_HERMES_SKILL_READ_FACTS) {
          const oldest = loaded.values().next().value;
          if (oldest !== undefined) loaded.delete(oldest);
          clipped = true;
        }

        if (item.toolCallId.length > MAX_SKILL_READ_CALL_ID_CHARS) omittedSkillReads += 1;
        else {
          // Hash the complete native content before compacting its tool text.
          // This observes what was read; it is not a new asset version or approval.
          skillReads.push({ ...skill, toolCallId: item.toolCallId, sequence: item.sequence });
          if (skillReads.length > MAX_HERMES_SKILL_READ_FACTS) {
            skillReads.shift();
            omittedSkillReads += 1;
          }
        }
      }
    }
  }

  visible.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  let messages = visible;
  let omitted = 0;
  const result = (): JsonObject => ({ schemaVersion: 1, messages, loadedSkills: [...loaded], skillReads, omittedSkillReads, omittedEntries: omitted,
    truncated: clipped || omitted > 0 || omittedSkillReads > 0,
    interpretation: "Observed task history. A successful tool result is not a verified task outcome. Skill reads and content hashes identify observed instruction loads, not task success, asset approval or promotion." });
  if (JSON.stringify(result()).length > maxChars) {
    // Keep the complete visible projection whenever it fits. Upstream only
    // digests older history on a cold, routed review; a fixed tail must not
    // discard short earlier failures/repairs before this transport needs space.
    const earlier = visible.slice(0, -24).map(item => item.role === "tool_exchange"
      ? { sequence: Number(item.sequence), role: "tool_summary", kind: "data", name: String(item.name), outcome: String(item.outcome), compacted: true }
      : { ...item, text: String(item.text).slice(0, item.role === "user" ? 300 : 200), compacted: true });

    messages = [...earlier, ...visible.slice(-24)];
    clipped = true;
  }

  while (JSON.stringify(result()).length > maxChars) {
    if (messages.length > 0) {
      messages = messages.slice(1);
      omitted += 1;
    }
    else if (skillReads.length > 0) {
      skillReads.shift();
      omittedSkillReads += 1;
    }
    else {
      const oldest = loaded.values().next().value;
      if (oldest === undefined) break;
      loaded.delete(oldest);
    }
    clipped = true;
  }

  return result();
}
