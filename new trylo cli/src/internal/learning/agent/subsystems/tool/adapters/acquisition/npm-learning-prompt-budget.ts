import type { npmLearningSource } from "./npm-learning-source.js";

type SourceView = ReturnType<typeof npmLearningSource>;

/** Optional source excerpts are paged under the grant. Task expectations are
 * never shortened to make an invalid oracle appear to fit. */
export function fitNpmLearningPrompt(source: SourceView, render: (view: SourceView) => string, maxPromptChars: number): string | undefined {
  const limit = Math.max(0, Math.min(24_000, maxPromptChars) - 768);

  for (const excerptChars of [8_000, 4_000, 2_000, 800, 0]) {
    for (const indexRows of [64, 24, 8, 0]) {
      let remaining = excerptChars;
      const excerpts: SourceView["excerpts"] = [];

      for (const row of source.excerpts) {
        if (remaining <= 0) break;
        const text = row.text.slice(0, remaining);
        remaining -= text.length;
        excerpts.push({ ...row, text, ...(text.length < row.text.length ? { truncated: true, nextOffset: row.offset + text.length } : {}) });
      }

      const view: SourceView = { ...source, index: source.index.slice(0, indexRows), excerpts,
        indexTruncated: source.indexTruncated || source.index.length > indexRows };
      const prompt = render(view);
      if (prompt.length <= limit) return prompt;
    }
  }

  return undefined;
}
