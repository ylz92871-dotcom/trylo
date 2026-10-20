import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../sandbox/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import { createImageReferenceRegistry } from "./image-reference-access.js";
import { withImageReferences } from "./image-reference-provider.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ImageReference } from "../../protocol/image-reference.js";
import { createWarmRegistry } from "../provider/warm.js";
import { buildProvider } from "../../surface/cli/provider-build.js";
import { imageReferencesFor } from "../../surface/cli/wiring-image-references.js";
import { createRunExecution } from "../../surface/cli/run-execution-wiring.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=";
const signal = new AbortController().signal;
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []; for await (const event of stream) result.push(event); return result;
}

async function fixture(run: (root: string, outside: string, references: ReturnType<typeof createImageReferenceRegistry>, images: readonly ImageReference[]) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "trylo-image-authority-"));
  const root = path.join(home, "workspace"); await mkdir(root);
  const outside = path.join(home, "outside.png"); await writeFile(outside, Buffer.from(png, "base64"));
  const references = createImageReferenceRegistry();
  try {
    const tools = createWorkspaceTools({ workspaceRoot: root,
      sandbox: createWorkspaceSandbox({ workspaceRoot: root, fileAccess: "reviewed" }), onImageValidated: references.register });
    const result = await tools.execute({ toolCallId: "view", name: "view_image", arguments: { path: outside } }, signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result" || result.images === undefined) throw new Error("missing image result");
    await run(root, outside, references, result.images);
  } finally { references.clear(); await rm(home, { recursive: true, force: true }); }
}

function request(images: readonly ImageReference[], historical = false): ProviderRequest {
  const message: ProviderMessage = { role: "tool", toolCallId: "view", content: "validated image", imageReferences: images };
  return { attemptId: "a", model: "fixture", tools: [], messages: historical ? [message, { role: "user", content: "continue" }] : [message] };
}

test("approved external images attach exact bytes; saved references alone cannot reauthorize them", async () => fixture(async (root, _outside, registry, images) => {
  const received: ProviderRequest[] = [];
  const transport: ProviderPort = { async *stream(input) { received.push(input); yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const provider = withImageReferences(transport, root, { resolve: registry.resolve });
  const events = await collect(provider.stream(request(images), signal));
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(received[0]?.messages[0]?.attachments?.[0]?.dataBase64, png);
  assert.equal(received[0]?.messages[0]?.imageReferences, undefined);
  const empty = createImageReferenceRegistry();
  const fresh = withImageReferences(transport, root, empty);
  const refused = await collect(fresh.stream(request(images), signal));
  assert.ok(refused.some(event => event.type === "error" && event.message === "image_reference_approval_required"));
  assert.equal(received.length, 1);
  const history = await collect(fresh.stream(request(images, true), signal));
  assert.ok(history.some(event => event.type === "warning" && event.code === "image_reference_approval_required"));
  assert.equal(received[1]?.messages[0]?.attachments, undefined);
  registry.clear();
  assert.ok((await collect(provider.stream(request(images), signal))).some(event => event.type === "error"));
  assert.equal(received.length, 2);
}));

test("external image approval pins the validated bytes rather than future file contents", async () => fixture(async (root, outside, registry, images) => {
  let sent = 0;
  const transport: ProviderPort = { async *stream() { sent++; yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  await writeFile(outside, "changed");
  const events = await collect(withImageReferences(transport, root, registry).stream(request(images), signal));
  assert.ok(events.some(event => event.type === "error" && event.message === "image_reference_changed"));
  assert.equal(sent, 0);
}));

test("warm transport reuse cannot retain another turn's external-image authority", async () => fixture(async (root, _outside, registry, images) => {
  const warm = createWarmRegistry();
  const input = { providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined, workspaceRoot: root,
    permission: { async request() { throw new Error("unused"); }, async awaitDecision() { throw new Error("unused"); } }, warm };
  const first = buildProvider(input, registry);
  const second = buildProvider(input, createImageReferenceRegistry());
  if (!("stream" in first) || !("stream" in second)) throw new Error("provider construction failed");
  assert.notEqual(first, second);
  assert.equal((await collect(first.stream(request(images), signal))).some(event => event.type === "error"), false);
  assert.ok((await collect(second.stream(request(images), signal))).some(event => event.type === "error"));
  assert.equal(warm.stats().builds, 1); assert.equal(warm.stats().hits, 1);
}));

test("image authority is absent by default and owned by the prepared session when lent", async () => fixture(async (root, outside, registry, images) => {
  assert.equal(imageReferencesFor({}), undefined);
  const own = imageReferencesFor({ fileAccess: "host" });
  assert.ok(own); own.record(images[0]!, outside); own.close(); assert.equal(own.read.resolve(images[0]!), undefined);
  const execution = createRunExecution(root, { fileAccess: "reviewed" });
  const borrowed = imageReferencesFor({ execution }); assert.ok(borrowed);
  borrowed.record(images[0]!, outside); borrowed.close();
  assert.ok(execution.imageReferences?.resolve(images[0]!));
  await execution.close(); assert.equal(execution.imageReferences?.resolve(images[0]!), undefined);
  assert.ok(registry.resolve(images[0]!));
}));
