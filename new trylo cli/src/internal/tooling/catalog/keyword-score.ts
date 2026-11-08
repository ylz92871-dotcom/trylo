export type SearchableTool = {
  readonly name: string;
  readonly searchHint: string;
  readonly description: string;
  readonly shouldDefer: boolean;
  readonly alwaysLoad: boolean;
};

const NAME_EXACT = 10;
const NAME_PARTIAL = 5;
const NAME_FULL = 3;
const HINT = 4;
const DESCRIPTION_BOUNDARY = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+]+/u)
    .filter((token) => token.length > 0);
}

function wordBoundaryHit(haystack: string, term: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(term)}(?:$|[^a-z0-9_])`, "i");
  return pattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scoreTool(query: string, tool: SearchableTool): number | undefined {
  const rawTerms = tokenize(query);
  if (rawTerms.length === 0) {
    return 0;
  }

  // A +term is a required match; optional terms affect ranking only.
  const required = rawTerms.filter((term) => term.startsWith("+") && term.length > 1).map((term) => term.slice(1));
  const optional = rawTerms.filter((term) => !term.startsWith("+"));
  const nameTokens = tokenize(tool.name);
  const hint = tool.searchHint.toLowerCase();
  const description = tool.description;

  for (const term of required) {
    const inName = nameTokens.some((token) => token.includes(term));
    const inHint = hint.includes(term);
    const inDesc = wordBoundaryHit(description, term);
    if (!inName && !inHint && !inDesc) {
      return undefined;
    }
  }

  let score = 0;

  for (const term of [...required, ...optional]) {
    for (const token of nameTokens) {
      if (token === term) {
        score += NAME_EXACT;
      } else if (token.includes(term) || term.includes(token)) {
        score += NAME_PARTIAL;
      }
    }

    if (tool.name.toLowerCase() === term) {
      score += NAME_FULL;
    }

    if (hint.includes(term)) {
      score += HINT;
    }

    if (wordBoundaryHit(description, term)) {
      score += DESCRIPTION_BOUNDARY;
    }
  }

  return score;
}

export function selectTools(query: string, tools: readonly SearchableTool[]): SearchableTool[] | undefined {
  const trimmed = query.trim();
  if (!trimmed.toLowerCase().startsWith("select:")) {
    return undefined;
  }

  const names = trimmed
    .slice("select:".length)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return tools.filter((tool) => names.includes(tool.name));
}

export function rankTools(query: string, tools: readonly SearchableTool[]): SearchableTool[] {
  // Explicit selection preserves the requested tool set instead of scoring it.
  const selected = selectTools(query, tools);
  if (selected !== undefined) {
    return selected;
  }

  const ranked: Array<{ tool: SearchableTool; score: number }> = [];

  for (const tool of tools) {
    const score = scoreTool(query, tool);
    if (score === undefined) {
      continue;
    }
    ranked.push({ tool, score });
  }

  ranked.sort((left, right) => right.score - left.score);

  return ranked.map((entry) => entry.tool);
}
