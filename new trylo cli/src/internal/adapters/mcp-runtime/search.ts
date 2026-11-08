import type { JsonObject } from "../../protocol/envelope.js";
import type { McpToolSpec } from "../../ports/mcp-client.js";

type SearchOptions = { readonly query: string; readonly limit: number };
type QueryTerms = { readonly literal: readonly string[]; readonly equivalents: readonly (readonly string[])[] };

// Language equivalents affect discovery ranking only. Every returned name and
// schema still comes from a configured server's live tools/list response.
const CAPABILITY_TERMS = [
  { pattern: /浏览器|网页|页面|browser|chrome|playwright|devtools/i,
    words: ["browser", "chrome", "playwright", "devtools", "page", "navigate"] },
  { pattern: /电脑|计算机|桌面|computer|desktop|windows/i,
    words: ["computer", "desktop", "windows"] },
  { pattern: /办公|文档|幻灯片|演示文稿|表格|office|word|excel|powerpoint|docx|xlsx|pptx/i,
    words: ["office", "officecli", "word", "excel", "powerpoint", "docx", "xlsx", "pptx", "document"] },
  { pattern: /截图|截屏|screenshot|screen.?capture/i,
    words: ["screenshot", "screen capture", "capture"] },
] as const;

export function readSearchOptions(input: JsonObject):
  | { readonly ok: true; readonly value: SearchOptions }
  | { readonly ok: false; readonly message: string } {
  const query = input.query, limit = input.limit ?? 5;
  if (query !== undefined && (typeof query !== "string" || query.length > 500)
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    return { ok: false, message: "query is at most 500 characters; limit is 1–10." };
  }
  return { ok: true, value: { query: typeof query === "string" ? query.trim() : "", limit } };
}

function queryTerms(query: string): QueryTerms {
  return { literal: query.toLowerCase().split(/\s+/).filter(Boolean),
    equivalents: CAPABILITY_TERMS.filter(group => group.pattern.test(query)).map(group => group.words) };
}

function score(text: string, terms: QueryTerms): number {
  const normalized = text.toLowerCase();
  return terms.literal.reduce((total, term) => total + (normalized.includes(term) ? 4 : 0), 0)
    + terms.equivalents.reduce((total, group) => total + (group.some(term => normalized.includes(term)) ? 1 : 0), 0);
}

/** A named capability need not wait for unrelated configured servers. Generic
 * tool queries inspect all configured candidates when no server name matches. */
export function candidateSearchServers(configured: readonly string[], query: string): readonly string[] {
  const terms = queryTerms(query);
  const matching = configured.filter(name => score(name, terms) > 0);
  return matching.length ? matching : configured;
}

export function rankSearchTools(tools: readonly McpToolSpec[], query: string): readonly McpToolSpec[] {
  const terms = queryTerms(query);
  return tools.map(spec => ({ spec, score: score(`${spec.serverId} ${spec.qualifiedName} ${spec.description}`, terms) }))
    .filter(item => query === "" || item.score > 0)
    .sort((a, b) => b.score - a.score || a.spec.qualifiedName.localeCompare(b.spec.qualifiedName))
    .map(item => item.spec);
}
