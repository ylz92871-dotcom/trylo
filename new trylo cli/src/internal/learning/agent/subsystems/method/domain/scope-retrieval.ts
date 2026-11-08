import { projectMaturity, type MaturityProjection, type ExperienceSource, type ScopeFact } from "./experience-state.js";

/** Ranking only: lexical resemblance never fills a missing predicate input or
 * qualifies an experience. Current facts must still pass exact matching. */
export function rankScopesForCue(source: ExperienceSource, scopes: readonly ScopeFact[], cue: string,
  maturity: MaturityProjection = projectMaturity(source)): readonly ScopeFact[] {
  const query = termsOf(cue);
  return scopes.map(scope => {
    const condition = maturity(scope.hypothesis)?.review.compact?.when ?? scope.description;
    const predicate = [...scope.hypothesis.predicate.all, ...scope.hypothesis.predicate.exclude]
      .map(literal => `${literal.feature} ${literal.value}`).join(" ");
    const terms = termsOf(`${condition} ${predicate}`);
    const common = [...query].filter(term => terms.has(term)).length;
    const score = query.size === 0 || terms.size === 0 ? 0 : common / Math.sqrt(query.size * terms.size);

    return { scope, score };
  }).sort((a, b) => b.score - a.score || b.scope.sequence - a.scope.sequence)
    .map(item => item.scope);
}

function termsOf(text: string): ReadonlySet<string> {
  const result = new Set<string>();

  for (const word of text.toLowerCase().slice(0, 8000).match(/[a-z0-9_]+|\p{Script=Han}+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length === 1) result.add(word);
      for (let index = 0; index + 1 < word.length; index += 1) result.add(word.slice(index, index + 2));
    } else if (word.length > 1) result.add(word);
  }

  return result;
}
