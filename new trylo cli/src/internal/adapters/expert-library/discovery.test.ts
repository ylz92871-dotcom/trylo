import assert from "node:assert/strict";
import test from "node:test";
import { createToolExpertResources } from "./resources.js";
import type { ExpertRequest } from "../../subagent/experts/contracts.js";

const request: ExpertRequest = { requestId: "r-discover", expertId: "e-discover", experienceKey: "expert:e-discover", origin: "settings",
  instruction: "创建一个熟悉工业机器人抓取的专项专家", state: "authorized", creationAuthorization: "user-consent", baseVersion: 0, revision: 1, createdAt: 1, userEdits: {} };
const signal = new AbortController().signal;

test("Chinese natural-language construction uses one authorized public index and retrieved original documents, never index summaries", async () => {
  const urls: string[] = [];
  const resources = createToolExpertResources({ availableToolNames: () => ["web_fetch"], async executeAuthorized(call) {
    assert.equal(call.name, "web_fetch");
    const url = String(call.arguments.url);
    urls.push(url);
    return { outcome: "result", value: { url, status: 200 }, truncated: false, output: urls.length === 1
      ? `<rss><channel><item><title>抓取专项官方文档</title><link>https://robot.example/docs?mode=grasp&amp;v=1</link><description>INDEX_SUMMARY_NOT_EVIDENCE</description></item></channel></rss>`
      : "ORIGINAL_SPECIALIST_GRASP_METHOD: inspect grasp pose and collision constraints." };
  } });
  const result = await resources.collect({ request, signal });

  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /^https:\/\/www\.bing\.com\/search\?/);
  assert.match(decodeURIComponent(urls[0]!), /工业机器人抓取/);
  assert.equal(urls[1], "https://robot.example/docs?mode=grasp&v=1");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.kind, "community");
  assert.match(result.sources[0]!.excerpt, /ORIGINAL_SPECIALIST/);
  assert.doesNotMatch(JSON.stringify(result.sources), /INDEX_SUMMARY/);
});

test("GitHub index discovery reads returned repositories' README content without inventing links or adding a model call", async () => {
  const urls: string[] = [];
  const resources = createToolExpertResources({ availableToolNames: () => ["web_fetch"], maxFetches: 1, async executeAuthorized(call) {
    const url = String(call.arguments.url);
    urls.push(url);
    return { outcome: "result", value: { url, status: 200 }, truncated: false, output: urls.length === 1
      ? JSON.stringify({ items: [{ full_name: "sql-owner/query-guidance", url: "https://api.github.com/repos/sql-owner/query-guidance", archived: false, description: "INDEX_ONLY" }] })
      : JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from("ORIGINAL_SQL_METHOD: inspect actual query cardinality", "utf8").toString("base64") }) };
  } });
  const result = await resources.collect({ request: { ...request, instruction: "I want you to create an expert in Kubernetes security" }, signal });

  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /^https:\/\/api\.github\.com\/search\/repositories\?/);
  assert.match(new URL(urls[0]!).searchParams.get("q")!, /Kubernetes security/);
  assert.doesNotMatch(new URL(urls[0]!).searchParams.get("q")!, /\b(want|you|to|an|expert|in)\b(?!:)/i);
  assert.equal(urls[1], "https://api.github.com/repos/sql-owner/query-guidance/readme");
  assert.match(result.sources[0]!.excerpt, /ORIGINAL_SQL_METHOD/);
  assert.doesNotMatch(result.sources[0]!.excerpt, /base64|INDEX_ONLY/);
});

test("resource discovery rejects challenges and explicit permission refusal instead of claiming a configured specialist", async () => {
  for (const denied of [false, true]) {
    let calls = 0;
    const resources = createToolExpertResources({ availableToolNames: () => ["web_fetch"], async executeAuthorized() {
      calls++;
      return denied ? { outcome: "error", code: "permission_denied", message: "User refused the index request" }
        : { outcome: "result", value: { url: "https://www.bing.com/search", status: 200 }, output: "Verify you are human challenge", truncated: false };
    } });
    await assert.rejects(resources.collect({ request, signal }), /index|permission_denied/);
    assert.equal(calls, 1);
  }
});
