import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testScratchPath } from "../../testing/scratch.js";
import { createMediaGenerationTools } from "./index.js";
import { generatedMediaArtifacts } from "../../protocol/generated-media.js";
import type { MediaConnection, MediaProtocol } from "./config.js";
import { MediaArtifacts } from "./artifacts.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";
function connection(protocol: MediaProtocol): MediaConnection {
  return { enabled: true, protocol, endpoint: "https://provider.invalid/api/v1", model: protocol === "replicate-video" ? "owner/model" : "configured-model", apiKey: "PRIVATE_MEDIA_KEY" };
}
function scratch(): string { return mkdtempSync(testScratchPath("media-generation-")); }
const call = (name: string, args: Record<string, string>) => ({ name, toolCallId: "test", arguments: args });

for (const protocol of ["openai-images", "dashscope-images", "gemini-images"] as const) test(`${protocol} preserves the provider's request shape and writes a metadata-only image receipt`, async () => {
  const root = scratch(), requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const port = createMediaGenerationTools({ workspaceRoot: root, configuration: { browserFallback: true, image: connection(protocol) },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json(protocol === "openai-images" ? { data: [{ b64_json: PNG }] }
        : protocol === "dashscope-images" ? { output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${PNG}` }] } }] } }
          : { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
    } });
  const outcome = await port.execute(call("image_generate", { prompt: "A calm workbench." }), new AbortController().signal);
  assert.equal(outcome.outcome, "result");
  if (outcome.outcome !== "result") return;
  const artifacts = generatedMediaArtifacts(outcome.value);
  assert.equal(artifacts?.length, 1);
  assert.equal(readFileSync(artifacts![0]!.path).toString("base64"), PNG);
  assert.equal(artifacts![0]!.mimeType, "image/png");
  assert.ok(artifacts![0]!.path.endsWith(".png"));
  assert.equal(JSON.stringify(outcome).includes(PNG), false);
  assert.equal(JSON.stringify(outcome).includes("PRIVATE_MEDIA_KEY"), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get(protocol === "gemini-images" ? "x-goog-api-key" : "authorization"), protocol === "gemini-images" ? "PRIVATE_MEDIA_KEY" : "Bearer PRIVATE_MEDIA_KEY");
  assert.ok(requests[0]!.url.endsWith(protocol === "openai-images" ? "/images/generations"
    : protocol === "dashscope-images" ? "/services/aigc/multimodal-generation/generation" : "/models/configured-model:generateContent"));
});

for (const protocol of ["ark-video", "dashscope-video", "replicate-video"] as const) test(`${protocol} resumes one durable video task and never creates it while checking status`, async () => {
  const root = scratch(), requests: { url: string; method: string; auth: string | null }[] = [];
  let queries = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    if (String(url).includes("cdn.invalid")) return new Response(Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]));
    if (init?.method === "POST") return Response.json(protocol === "dashscope-video" ? { output: { task_id: "remote-task" } } : { id: "remote-task" });
    queries++;
    return Response.json(protocol === "ark-video" ? { status: queries === 1 ? "running" : "succeeded", content: { video_url: "https://cdn.invalid/video.mp4" } }
      : protocol === "dashscope-video" ? { output: { task_status: queries === 1 ? "RUNNING" : "SUCCEEDED", video_url: "https://cdn.invalid/video.mp4" } }
        : { status: queries === 1 ? "processing" : "succeeded", output: "https://cdn.invalid/video.mp4" });
  };
  const workspace = protocol === "ark-video" ? path.join(scratch(), "workspace-alias") : root;
  if (workspace !== root) symlinkSync(root, workspace, "junction");
  const input = { workspaceRoot: workspace, configuration: { browserFallback: true, video: connection(protocol) }, fetch };
  const started = await createMediaGenerationTools(input).execute(call("video_generate", { prompt: "A slow camera move." }), new AbortController().signal);
  assert.equal(started.outcome, "result");
  if (started.outcome !== "result" || typeof started.value.job_id !== "string") return;
  const resumed = createMediaGenerationTools(input), get = call("video_get_result", { job_id: started.value.job_id });
  const pending = await resumed.execute(get, new AbortController().signal);
  assert.equal(pending.outcome === "result" && pending.value.status, "running");
  const completed = await resumed.execute(get, new AbortController().signal);
  assert.equal(completed.outcome, "result");
  if (completed.outcome !== "result") return;
  const artifact = generatedMediaArtifacts(completed.value)?.[0];
  assert.equal(artifact?.mimeType, "video/mp4");
  assert.ok(artifact?.path.endsWith(".mp4"));
  assert.equal(readFileSync(artifact!.path).length, 16);
  const repeated = await resumed.execute(get, new AbortController().signal);
  assert.equal(repeated.outcome, "result");
  if (repeated.outcome === "result") assert.equal(repeated.value.fileWrites, undefined, "re-reading a receipt is not another file creation");
  assert.equal(requests.filter(request => request.method === "POST").length, 1);
  assert.equal(queries, 2);
  assert.equal(requests.find(request => request.url.includes("cdn.invalid"))?.auth, null);
  assert.equal(JSON.stringify(completed).includes("PRIVATE_MEDIA_KEY"), false);
  assert.ok(readdirSync(path.join(root, ".trylo", "media-jobs")).length === 1);
});

test("an existing output and a directory junction cannot redirect or overwrite a generated artifact", async () => {
  const root = scratch(), outside = scratch();
  symlinkSync(outside, path.join(root, "escape"), "junction");
  writeFileSync(path.join(root, "existing.png"), "original");
  let requests = 0;
  const port = createMediaGenerationTools({ workspaceRoot: root, configuration: { browserFallback: true, image: connection("openai-images") },
    fetch: async () => { requests++; throw new Error("Must not submit"); } });
  for (const target of ["existing.png", "escape/new.png"]) {
    const result = await port.execute(call("image_generate", { prompt: "A scene.", path: target }), new AbortController().signal);
    assert.equal(result.outcome, "error");
  }
  assert.equal(requests, 0);
  assert.equal(readFileSync(path.join(root, "existing.png"), "utf8"), "original");
});

test("cancelling an unacknowledged create retains outcome-unknown instead of claiming no work happened", async () => {
  const controller = new AbortController();
  const port = createMediaGenerationTools({ workspaceRoot: scratch(), configuration: { browserFallback: true, video: connection("ark-video") },
    fetch: async () => { controller.abort(); throw new Error("Request was interrupted after submission"); } });
  const result = await port.execute(call("video_generate", { prompt: "A scene." }), controller.signal);
  assert.equal(result.outcome, "unknown");
});

test("a provider's terminal failed job is reported without polling advice or a replacement POST", async () => {
  let posts = 0;
  const port = createMediaGenerationTools({ workspaceRoot: scratch(), configuration: { browserFallback: true, video: connection("ark-video") },
    fetch: async (_url, init) => {
      if (init?.method === "POST") { posts++; return Response.json({ id: "failed-job" }); }
      return Response.json({ status: "failed", error: { message: "PRIVATE_PROVIDER_DETAIL" } });
    } });
  const created = await port.execute(call("video_generate", { prompt: "A scene." }), new AbortController().signal);
  assert.equal(created.outcome, "result");
  if (created.outcome !== "result" || typeof created.value.job_id !== "string") return;
  const result = await port.execute(call("video_get_result", { job_id: created.value.job_id }), new AbortController().signal);
  assert.equal(result.outcome === "error" && result.code, "media_generation_failed");
  assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_DETAIL"), false);
  assert.equal(posts, 1);
});

test("a saved video with a failed delivery receipt remains outcome-unknown with its file preserved", async context => {
  context.mock.method(MediaArtifacts.prototype, "completeJob", async () => { throw new Error("Receipt disk is unavailable"); });
  const root = scratch();
  let posts = 0;
  const port = createMediaGenerationTools({ workspaceRoot: root, configuration: { browserFallback: true, video: connection("ark-video") },
    fetch: async (url, init) => {
      if (String(url).includes("cdn.invalid")) return new Response(Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]));
      if (init?.method === "POST") { posts++; return Response.json({ id: "task" }); }
      return Response.json({ status: "succeeded", content: { video_url: "https://cdn.invalid/video.mp4" } });
    } });
  const created = await port.execute(call("video_generate", { prompt: "A scene." }), new AbortController().signal);
  if (created.outcome !== "result" || typeof created.value.job_id !== "string") assert.fail("Expected a durable job");
  const result = await port.execute(call("video_get_result", { job_id: created.value.job_id }), new AbortController().signal);
  assert.equal(result.outcome === "unknown" && result.code, "media_delivery_outcome_unknown");
  assert.equal(readdirSync(path.join(root, ".trylo/out/media")).filter(file => file.endsWith(".mp4")).length, 1);
  assert.equal(posts, 1);
});

test("a lost create acknowledgement is unknown and never automatically resubmitted", async () => {
  let requests = 0;
  const port = createMediaGenerationTools({ workspaceRoot: scratch(), configuration: { browserFallback: true, video: connection("ark-video") },
    fetch: async () => { requests++; throw new Error("Connection closed after provider may have accepted the task"); } });
  const result = await port.execute(call("video_generate", { prompt: "A scene." }), new AbortController().signal);
  assert.equal(result.outcome, "unknown");
  assert.equal(requests, 1);
});

test("invalid output scope is rejected before a generation request can spend credits", async () => {
  let requests = 0;
  const port = createMediaGenerationTools({ workspaceRoot: scratch(), configuration: { browserFallback: true, image: connection("openai-images") },
    fetch: async () => { requests++; return Response.json({ data: [{ b64_json: PNG }] }); } });
  const result = await port.execute(call("image_generate", { prompt: "A scene.", path: "../foreign.png" }), new AbortController().signal);
  assert.equal(result.outcome === "error" && result.code, "media_output_outside_workspace");
  assert.equal(requests, 0);
});
