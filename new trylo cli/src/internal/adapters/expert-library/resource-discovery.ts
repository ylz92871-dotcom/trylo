import type { ExpertResourceOptions } from "./resources.js";
import { ExpertLibraryError } from "../../subagent/experts/contracts.js";
import { expertResourceFailure, expertWebResponse, isExpertWebUri, requireExpertResourceActive } from "./resource-response.js";

export type ExpertSourceCandidate = { readonly uri: string; readonly title: string };

const REQUEST_WORDS = new Set("a an and are as at be based build can concise configure create expert expertise familiar focused for from give help how i in into is it knowledgeable make me my need of on one or our please professional provide request role should skilled specialist specialize specialized specializing that the their this to want we who will with would you your".split(" "));

/** One public index request, no model invocation, pagination or automatic retries. */
export async function discoverExpertSources(input: Pick<ExpertResourceOptions, "executeAuthorized"> & {
  readonly instruction: string; readonly callId: string; readonly maxResults: number; readonly signal: AbortSignal;
}): Promise<readonly ExpertSourceCandidate[]> {
  // Latin topic terms use the repository index; other requests use the RSS index.
  const latin = [...new Set(input.instruction.match(/[a-zA-Z][a-zA-Z0-9+#._-]{1,40}/g) ?? [])]
    .filter(word => !REQUEST_WORDS.has(word.toLowerCase()) && word.toLowerCase() !== "agent").slice(0, 4);
  const github = latin.length > 0;
  const url = github ? `https://api.github.com/search/repositories?q=${encodeURIComponent(`${latin.join(" ")} in:name,description,readme archived:false`)}&per_page=${input.maxResults}`
    : `https://www.bing.com/search?format=rss&q=${encodeURIComponent(`${input.instruction.slice(0, 320)} 官方文档 开源专项资源`)}`;
  const outcome = await input.executeAuthorized({ name: "web_fetch", toolCallId: input.callId, arguments: { url } }, input.signal);

  requireExpertResourceActive(outcome, input.signal);
  const response = expertWebResponse(outcome);
  if (!response || outcome.outcome !== "result" || outcome.truncated) throw expertResourceFailure("Specialist resource index", outcome);

  const candidates = github ? githubRepositories(response.text) : rssLinks(response.text);
  if (candidates.length === 0) throw new ExpertLibraryError("resource_unavailable", "The specialist resource index returned no readable source links or an access challenge; no specialist evidence was obtained");

  return candidates.slice(0, input.maxResults);
}

function githubRepositories(body: string): ExpertSourceCandidate[] {
  const value = parsedJson(body);
  if (!record(value) || !Array.isArray(value.items)) return [];

  return value.items.flatMap(item => {
    if (!record(item) || item.archived === true || typeof item.full_name !== "string" || typeof item.url !== "string"
      || !/^https:\/\/api\.github\.com\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(item.url)) return [];
    return [{ uri: `${item.url}/readme`, title: `${item.full_name} README` }];
  });
}

function rssLinks(body: string): ExpertSourceCandidate[] {
  if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body)) return [];

  const links: ExpertSourceCandidate[] = [];

  for (const match of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1]!;
    const uri = decodeXml(/<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(item)?.[1] ?? "");
    const title = decodeXml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? uri);
    if (isExpertWebUri(uri) && !["www.bing.com", "bing.com"].includes(new URL(uri).hostname)) links.push({ uri, title });
  }

  return [...new Map(links.map(item => [item.uri, item])).values()];
}

/** GitHub's JSON representation contains original README bytes, not search snippets. */
export function expertDocumentText(uri: string, body: string): string | undefined {
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/readme(?:\?|$)/.test(uri)) return body;

  const value = parsedJson(body);
  if (!record(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string") return undefined;

  const encoded = value.content.replace(/\s/g, "");
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) return undefined;

  const bytes = Buffer.from(encoded, "base64");

  // A successful base64 decode alone does not prove the original encoding was valid.
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return undefined;

  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; /* Invalid file encoding is not specialist evidence. */ }
}

function parsedJson(value: string): unknown { try { return JSON.parse(value); }catch { return undefined; /* An index/challenge page is not the advertised JSON response. */ } }

function record(value: unknown): value is Readonly<Record<string, unknown>> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function decodeXml(value: string): string {
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}
