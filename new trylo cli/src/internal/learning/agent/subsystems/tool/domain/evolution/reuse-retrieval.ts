/** A bounded projection of the existing library, never a tool registration or capability verdict. */
export type ToolReuseSummary = { readonly toolId: string; readonly description: string; readonly versionId?: string };

export type ToolReuseCandidate = ToolReuseSummary & { readonly name: string; readonly capabilities: readonly string[] };

export type ToolLibraryInvestigation = { readonly query: string; readonly candidates: readonly ToolReuseSummary[];
  readonly total: number; readonly truncated: boolean };

const COMMON_TERMS: ReadonlySet<string> = new Set(["tool", "tools", "use", "using", "need", "needs", "with", "from", "that", "this", "have", "the", "and", "for", "can", "a", "an", "to", "of", "in", "runtime", "工具", "使用", "需要", "能力", "任务"]);

/** Multi-view lexical retrieval narrows context; the learning model still judges semantic fit. */
export function retrieveToolReuseCandidates(input: { readonly candidates: readonly ToolReuseCandidate[]; readonly query: string;
  readonly target?: string; readonly targetVersionId?: string; readonly limit?: number }): readonly ToolReuseSummary[] {
  const candidates = input.candidates.slice(0, 768).map(candidate => ({ ...candidate, name: candidate.name.slice(0, 512),
    capabilities: candidate.capabilities.slice(0, 16).map(text => text.slice(0, 512)), description: candidate.description.slice(0, 4_096) }));
  const terms = queryTerms(input.query), limit = Math.max(1, Math.min(24, input.limit ?? 24));
  const views = candidates.map(candidate => ({ candidate, name: normalize(`${candidate.toolId} ${candidate.name}`),
    capabilities: normalize(candidate.capabilities.join(" ")), description: normalize(candidate.description) }));
  const frequencies = new Map(terms.map(term => [term, views.filter(row => row.name.includes(term) || row.capabilities.includes(term) || row.description.includes(term)).length]));
  const ranked = views.map((row, order) => {
    const exact = row.candidate.toolId === input.target || row.candidate.name === input.target
      || (input.targetVersionId !== undefined && row.candidate.versionId === input.targetVersionId);
    const score = terms.reduce((sum, term) => sum + Math.log(1 + (views.length + 1) / ((frequencies.get(term) ?? 0) + 1))
      * ((row.name.includes(term) ? 4 : 0) + (row.capabilities.includes(term) ? 3 : 0) + (row.description.includes(term) ? 1 : 0)), 0);
    return { candidate: row.candidate, exact, score, order };
  }).sort((left, right) => Number(right.exact) - Number(left.exact) || right.score - left.score || left.order - right.order);
  const selected = ranked.filter(row => row.exact || row.score > 0).slice(0, limit).map(row => row.candidate);
  // A few low-score alternatives preserve model choice when words differ across languages or naming schemes.
  const fallbacks = ranked.filter(row => !selected.some(item => item.toolId === row.candidate.toolId));
  const fallbackTarget = Math.min(limit, Math.max(4, selected.length + 3), ranked.length);

  while (selected.length < fallbackTarget && fallbacks.length > 0) {
    const index = Math.floor((selected.length % 4) * fallbacks.length / 4);
    const chosen = fallbacks.splice(index, 1)[0];
    if (chosen !== undefined) selected.push(chosen.candidate);
  }

  return selected.map(candidate => ({ toolId: candidate.toolId,
    description: `${candidate.name}. Capabilities: ${candidate.capabilities.join("; ")}. ${candidate.description}`.slice(0, 1_536),
    ...(candidate.versionId === undefined ? {} : { versionId: candidate.versionId }) }));
}

function normalize(text: string): string { return text.normalize("NFKC").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase(); }

function queryTerms(query: string): readonly string[] {
  const terms = new Set<string>(), normalized = normalize(query).slice(0, 2_048);

  for (const word of normalized.match(/[a-z0-9]{2,}|\p{Script=Han}{2,}/gu) ?? []) {
    if (COMMON_TERMS.has(word)) continue;
    if (/^\p{Script=Han}+$/u.test(word)) {
      if (word.length <= 8) terms.add(word);
      for (let index = 0; index < word.length - 1; index++) if (!COMMON_TERMS.has(word.slice(index, index + 2))) terms.add(word.slice(index, index + 2));
    } else terms.add(word);
    if (terms.size >= 64) break;
  }

  return [...terms].slice(0, 64);
}
