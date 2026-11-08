import type { ToolNpmResearchReferences } from "../../domain/evolution/research.js";
import type { npmLearningSource } from "./npm-learning-source.js";
import { fitNpmLearningPrompt } from "./npm-learning-prompt-budget.js";

/** Installed bytes and the frozen task take priority. Historical references fill
 * only spare prompt space, so a long repository README cannot evict the actual API. */
export function fitNpmLearningResearchPrompt(source: ReturnType<typeof npmLearningSource>, references: ToolNpmResearchReferences | undefined,
  render: (source: ReturnType<typeof npmLearningSource>, references?: ToolNpmResearchReferences) => string, maxPromptChars: number) {
  const limit = Math.max(0, Math.min(24_000, maxPromptChars) - 768);
  return fitNpmLearningPrompt(source, view => {
    const base = render(view);
    if (references === undefined || references.observations.length === 0 || base.length > limit) return base;

    for (const chars of [2_000, 800, 200, 0]) {
      const bounded = { ...references, observations: references.observations.map(observation => ({ ...observation,
        documents: observation.documents.map(document => document.text === undefined ? document : ({ ...document, text: document.text.slice(0, chars),
          truncated: document.truncated || document.text.length > chars })) })) };
      const prompt = render(view, bounded);
      if (prompt.length <= limit) return prompt;
    }

    return base;
  }, maxPromptChars);
}
