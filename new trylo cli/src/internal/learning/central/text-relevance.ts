/** Bounded navigation terms, following existing Latin words/Han bigram recall.
 * Text resemblance never establishes applicability, truth or evidence strength. */
export function centralTextTerms(text: string): ReadonlySet<string> {
  const normalized = text.slice(0, 8192).normalize("NFKC").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
  const terms = new Set<string>();

  for (const word of normalized.match(/[a-z0-9_]+|\p{Script=Han}+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length === 1) terms.add(word);
      for (let index = 0; index + 1 < word.length; index++) terms.add(word.slice(index, index + 2));
    } else if (word.length > 1) terms.add(word);
  }

  return terms;
}

export function centralTextRelevance(query: string, document: string): number {
  const wanted = centralTextTerms(query), available = centralTextTerms(document);
  if (wanted.size === 0 || available.size === 0) return 0;
  let common = 0;
  for (const term of wanted) if (available.has(term)) common++;

  // Normalize overlap by both vocabularies so larger documents do not win by size alone.
  return common / Math.sqrt(wanted.size * available.size);
}
