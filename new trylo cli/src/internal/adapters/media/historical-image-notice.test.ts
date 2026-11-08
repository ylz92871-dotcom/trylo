import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderMessage, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ImageReference } from "../../protocol/image-reference.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createImageReferenceRegistry } from "./image-reference-access.js";
import { withImageReferences } from "./image-reference-provider.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
const signal = new AbortController().signal;
const upstreamWarning: ProviderEvent = { type: "warning", code: "upstream_notice", message: "The upstream provider reported its own diagnostic." };

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

for (const cause of ["changed", "deleted", "approval"] as const) {
  test(`${cause} historical images stay model-visible without user warnings across turns, while current delivery remains strict`, async () => {
    const home = await mkdtemp(join(testScratchPath(), "image-history-notice-"));
    const root = join(home, "workspace");
    await mkdir(root);
    const path = cause === "approval" ? join(home, "outside.png") : join(root, "image.png");
    await writeFile(path, PNG);
    const reference: ImageReference = { path: cause === "approval" ? path : "image.png",
      sha256: createHash("sha256").update(PNG).digest("hex"), bytes: PNG.length, detail: "high" };
    const expected = cause === "changed" ? "image_reference_changed"
      : cause === "deleted" ? "image_reference_unavailable" : "image_reference_approval_required";
    const received: ProviderRequest[] = [];
    const transport: ProviderPort = { async *stream(request) {
      received.push(request);
      yield upstreamWarning;
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };
    const provider = withImageReferences(transport, root, createImageReferenceRegistry());
    const historical: ProviderMessage = { role: "tool", toolCallId: "view", content: "Earlier image result.", imageReferences: [reference] };

    try {
      if (cause === "changed") {
        const changed = Buffer.from(PNG);
        changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
        await writeFile(path, changed);
      } else if (cause === "deleted") await rm(path);

      for (const scope of ["first-turn", "next-turn"]) {
        const events = await collect(provider.stream({ attemptId: scope, continuationScope: scope, model: "fixture", tools: [],
          messages: [historical, { role: "user", content: "Continue the current task using available context." }] }, signal));
        assert.deepEqual(events.filter(event => event.type === "warning"), [upstreamWarning], "historical degradation cannot create a repeated chat banner or suppress unrelated warnings");
        assert.equal(events.some(event => event.type === "error"), false);
        const delivered = received.at(-1)?.messages[0];
        assert.equal(delivered?.attachments, undefined, "current bytes must not stand in for the unavailable old version");
        assert.match(delivered?.content ?? "", new RegExp(expected));
        assert.match(delivered?.content ?? "", /current file is not the historical snapshot/i);
        assert.match(delivered?.content ?? "", /only if needed.*current permissions/i);
        assert.match(delivered?.content ?? "", /do not repeatedly call view_image/i);
      }

      assert.equal(received.length, 2);
      const current = await collect(provider.stream({ attemptId: "current-image", model: "fixture", tools: [], messages: [historical] }, signal));
      assert.equal(received.length, 2, "a current image that failed validation must not silently become a historical placeholder");
      assert.ok(current.some(event => event.type === "error" && event.class === "invalid_request" && event.message === expected));
      assert.equal(current.some(event => event.type === "warning"), false);
      assert.equal(reference.sha256, createHash("sha256").update(PNG).digest("hex"));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
