import type { JsonObject } from "../../../../../protocol/envelope.js";

/** Names remain discoverable when detailed child evidence is omitted. These
 * are separate observation categories, never success or permission decisions.
 */
export function priorSkillHints(loaded: readonly string[], provided: readonly string[], maxChars = 4000): JsonObject {
  if (loaded.length === 0 && provided.length === 0) return {};

  const reads = [...loaded], provisions = [...provided];
  let omittedPriorLoadedSkills = 0, omittedPriorProvidedSkills = 0, trimReads = true;
  const result = (): JsonObject => ({ priorLoadedSkills: reads, priorProvidedSkills: provisions,
    omittedPriorLoadedSkills, omittedPriorProvidedSkills,
    priorSkillContextInterpretation: "Prior tool instruction reads and prior acknowledged explicit content provision are separate observed hints. Neither proves task success, permission or current skill approval. Re-read relevant current skills." });

  while (JSON.stringify(result()).length > maxChars) {
    // Alternate categories and remove only the oldest retained name in each;
    // this bounds transport without ranking lessons or choosing skill assets.
    if (reads.length > 0 && (trimReads || provisions.length === 0)) {
      reads.shift();
      omittedPriorLoadedSkills++;
    }
    else if (provisions.length > 0) {
      provisions.shift();
      omittedPriorProvidedSkills++;
    }
    else {
      const omitted = { omittedPriorLoadedSkills, omittedPriorProvidedSkills };
      return JSON.stringify(omitted).length <= maxChars ? omitted : {};
    }
    trimReads = !trimReads;
  }

  return result();
}
