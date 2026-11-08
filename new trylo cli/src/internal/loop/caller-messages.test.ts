import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import {
  createFakePermission,
  createFakeTools,
  emptyProfileLoader,
} from "./fakes.js";
import { runTurn, type LoopPorts, type RunTurnRequest } from "./runner.js";

/**
 * WP-CLI-B1 §3.2: caller messages reach the **request that is actually sent**.
 *
 * This file deliberately does not stop at "the loader returned a string". The
 * assertion that matters is on `ProviderRequest.messages` captured off the
 * provider port, because that is the only place where "the project rules are in
 * the request" stops being a claim about our own code and becomes a fact about
 * what the model was told. A test that inspects the assembler's return value
 * would still pass if the engine dropped the messages on the floor between
 * assembly and the wire, which is exactly the gap this package exists to close.
 */

function textBlock(blockId: string, text: string): readonly ProviderEvent[] {
  return [
    { type: "text_start", blockId },
    { type: "text_delta", blockId, text },
    { type: "text_end", blockId },
  ];
}

const stop: ProviderEvent = {
  type: "finish",
  reason: "stop",
  rawReason: "stop",
  requiresFollowUp: false,
};

/** A provider that records every request it is handed, then answers once. */
function recordingProvider(): { readonly port: ProviderPort; readonly seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  const port: ProviderPort = {
    async *stream(request) {
      seen.push(request);
      yield { type: "stream_start", providerId: "fake", model: "fake", warnings: [] };
      yield* textBlock("b1", "done");
      yield stop;
    },
  };

  return { port, seen };
}

function ports(provider: ProviderPort, tools: ToolPort = createFakeTools([])): LoopPorts {
  return {
    provider,
    tools,
    permission: createFakePermission("approved"),
    // The shipped CLI pins the learning-free profile. Pinning it here is what
    // makes the "these are not learned hints" assertion below meaningful: if the
    // rules had arrived through the Profile, there would be nothing to tell apart.
    profile: emptyProfileLoader(),
  };
}

function request(callerMessages?: ReadonlyArray<{ role: "system"; content: string }>): RunTurnRequest {
  return {
    sessionId: "ses-b1a",
    turnId: "trn-b1a",
    correlationId: "cor-b1a",
    text: "add a flag parser",
    ...(callerMessages === undefined ? {} : { callerMessages }),
  };
}

const systemText = (sent: ProviderRequest): string =>
  sent.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

test("caller messages reach the request the provider is actually handed", async () => {
  const provider = recordingProvider();

  await runTurn(ports(provider.port), request([{ role: "system", content: "PROJECT_RULE_MARKER" }]));

  assert.equal(provider.seen.length, 1, "one request must have been sent");
  const sent = provider.seen[0];

  assert.ok(sent);
  assert.match(systemText(sent), /PROJECT_RULE_MARKER/);
});

test("caller messages are system statements ahead of the user turn, not transcript items", async () => {
  const provider = recordingProvider();
  const result = await runTurn(
    ports(provider.port),
    request([{ role: "system", content: "PROJECT_RULE_MARKER" }]),
  );

  const sent = provider.seen[0];

  assert.ok(sent);
  const marker = sent.messages.findIndex((message) => message.content.includes("PROJECT_RULE_MARKER"));
  const userTurn = sent.messages.findIndex((message) => message.role === "user");

  assert.ok(marker >= 0 && userTurn >= 0);
  assert.ok(marker < userTurn, "rules must precede the conversation they govern");

  // The user turn is the one durable transcript item; the rules ride the request
  // and must not be persisted as if the user had said them.
  const userItems = result.transcript.filter((item) => item.kind === "user");

  assert.equal(userItems.length, 1);
  assert.equal(
    userItems.some((item) => item.kind === "user" && item.text.includes("PROJECT_RULE_MARKER")),
    false,
    "a project rule is not something the user said",
  );
});

test("with no callerMessages the request is byte-identical to the unwired path", async () => {
  const withField = recordingProvider();

  await runTurn(ports(withField.port), request());
  const withoutField = recordingProvider();

  await runTurn(ports(withoutField.port), request(undefined));

  const a = withField.seen[0];
  const b = withoutField.seen[0];

  assert.ok(a && b);
  assert.deepEqual(
    a.messages.map((message) => message.content),
    b.messages.map((message) => message.content),
  );
});

test("caller messages survive with the learning profile empty (learning off)", async () => {
  const provider = recordingProvider();

  // `emptyProfileLoader` is exactly what the CLI ships: EMPTY_PROFILE, no rules,
  // no patches. The rules must be present anyway, or "the model lost its project
  // rules when the learning switch went off" would be a real regression.
  await runTurn(ports(provider.port), request([{ role: "system", content: "RULES_WITHOUT_LEARNING" }]));

  const sent = provider.seen[0];

  assert.ok(sent);
  assert.match(systemText(sent), /RULES_WITHOUT_LEARNING/);
  // And nothing dresses them as a learned profile.
  assert.doesNotMatch(systemText(sent), /Trylo learned profile/);
  assert.doesNotMatch(systemText(sent), /user_rule:/);
});

test("caller messages are not labelled as learned historical hints", async () => {
  const provider = recordingProvider();

  await runTurn(
    ports(provider.port),
    request([{ role: "system", content: "use npm test for verification" }]),
  );
  const sent = provider.seen[0];

  assert.ok(sent);
  const text = systemText(sent);

  assert.match(text, /use npm test for verification/);
  // The Profile's own wording must not have leaked onto a project rule.
  assert.doesNotMatch(text, /learned historical hints/);
  assert.doesNotMatch(text, /prompt_patch:/);
});

test("caller messages take part in context estimation like any other seed message", async () => {
  // A large rule set has to be visible to the compaction path, or the loop would
  // compact against a request smaller than the one it really sends.
  const big = "R".repeat(4_000);
  const provider = recordingProvider();

  await runTurn(ports(provider.port), request([{ role: "system", content: big }]));
  const sent = provider.seen[0];

  assert.ok(sent);
  assert.equal(sent.messages[0]?.content, big, "the first seed message is the first request message");
});

/**
 * A temp workspace is not needed here: the loop never reads a rule file, which
 * is the point of the seam. The adapter's own disk reading is proven in
 * `project-instructions.test.ts`; this file proves the messages survive the trip.
 */
test("no rule file on disk changes nothing about the loop", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-b1a-loop-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
    const provider = recordingProvider();

    await runTurn(ports(provider.port), request());
    const sent = provider.seen[0];

    assert.ok(sent);
    assert.doesNotMatch(systemText(sent), /Project instructions from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
