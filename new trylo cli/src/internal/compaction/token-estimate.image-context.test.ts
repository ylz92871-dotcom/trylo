import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage } from "../ports/provider.js";
import type { ImageDetail } from "../ports/media.js";
import { estimateMessageTokens } from "./token-estimate.js";

const details: readonly ImageDetail[] = ["high", "original"];
const textOnly: ProviderMessage = { role: "user", content: "Inspect this screenshot." };

test("compressed image bytes do not become context tokens for durable references", () => {
  const estimate = (bytes: number): number => estimateMessageTokens({ ...textOnly,
    imageReferences: [{ path: "screen.png", sha256: "a".repeat(64), bytes, detail: "high" }],
  });

  // Compression/file size says nothing about a model's visual token formula.
  // The local value is the text-only lower basis, not a complete image cost.
  assert.equal(estimate(600), estimateMessageTokens(textOnly));
  assert.equal(estimate(6_000_000), estimate(600));
});

test("hydrated base64 size does not inflate the same local text estimate", () => {
  const estimate = (dataBase64: string, bytes: number): number => estimateMessageTokens({ ...textOnly,
    attachments: [{ mediaType: "image/png", dataBase64, bytes, detail: "original" }],
  });
  assert.equal(estimate("a".repeat(800), 600), estimateMessageTokens(textOnly));
  assert.equal(estimate("a".repeat(800_000), 600_000), estimate("a".repeat(800), 600));
});

test("image detail does not select a fabricated cross-model visual formula", () => {
  const estimates = details.map(detail => estimateMessageTokens({ ...textOnly,
    attachments: [{ mediaType: "image/png", dataBase64: "a".repeat(800), bytes: 600, detail }],
    imageReferences: [{ path: "second.png", sha256: "b".repeat(64), bytes: 6_000_000, detail }],
  }));
  assert.deepEqual(estimates, details.map(() => estimateMessageTokens(textOnly)));
});

test("omitting unknown visual usage still counts text and actual tool JSON", () => {
  const withCall: ProviderMessage = { role: "assistant", content: "Inspecting.",
    toolCalls: [{ toolCallId: "call-a", name: "inspect", arguments: { description: "x".repeat(4_000) } }],
  };
  const withImage: ProviderMessage = { ...withCall,
    imageReferences: [{ path: "screen.png", sha256: "c".repeat(64), bytes: 6_000_000, detail: "high" }],
  };

  assert.ok(estimateMessageTokens(withCall) > 1_000);
  assert.equal(estimateMessageTokens(withImage), estimateMessageTokens(withCall));
});
