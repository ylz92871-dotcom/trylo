import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import {
  createFakePermission,
  createFakeTools,
  emptyProfileLoader,
} from "../../loop/fakes.js";
import { runTurn, type LoopPorts } from "../../loop/runner.js";
import { projectContextFor } from "./project-rules.js";
import type { CliContext } from "./context.js";

/**
 * WP-CLI-B1 §3.3: the contract evidence for the whole first hop.
 *
 * `caller-messages.test.ts` proves the *seam* — that messages handed to the loop
 * survive to the wire. `project-instructions.test.ts` proves the *adapter* — that
 * a real `AGENTS.md` on a real disk becomes messages. Neither proves the two are
 * joined, and the join is the part that can rot silently: a resolver whose
 * output nobody passes to `RunTurnRequest` leaves both files green while the
 * model never sees a project's rules.
 *
 * So this file runs the real chain end to end — real temp directory, real
 * `projectContextFor` over the real filesystem reader, real `runTurn` — and
 * swaps out exactly one thing: the provider, which records the request instead
 * of answering it. That is the substitution WP §3.3 asks for ("record on the
 * provider port in tests; do not add whole-request logging to the product"),
 * because a product-side request log would be a permanent record of prompts
 * and a place for a credential to end up.
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

/** Records every request it is handed, then answers once. */
function recordingProvider(): { readonly port: ProviderPort; readonly seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  const port: ProviderPort = {
    async *stream(request) {
      seen.push(request);
      yield { type: "stream_start", providerId: "fake", model: "fake", warnings: [] };
      yield* textBlock("b1", "understood");
      yield stop;
    },
  };

  return { port, seen };
}

/** A context that answers only what the project-rule resolver asks for. */
function contextFor(cwd: string): CliContext {
  return {
    env: {},
    homeDir: cwd,
    cwd,
    nodeVersion: "v22.0.0",
    platform: "linux",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}-b1e2e`,
  };
}

function ports(provider: ProviderPort, tools: ToolPort = createFakeTools([])): LoopPorts {
  return {
    provider,
    tools,
    permission: createFakePermission("approved"),
    // The shipped CLI's learning-free profile. Pinning it is what makes the
    // "not dressed as a learned profile" assertion mean something: with a
    // populated Profile there would be nothing to tell the two apart.
    profile: emptyProfileLoader(),
  };
}

const systemText = (sent: ProviderRequest): string =>
  sent.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

function workspaceWith(
  files: Readonly<Record<string, string>>,
): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-b1e2e-"));

  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a real AGENTS.md reaches the request the provider is handed", async () => {
  const workspace = workspaceWith({
    "AGENTS.md": "Verification: run `npm test` before claiming done.\n",
  });
  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context, "the resolver must have found the rule file");

    const provider = recordingProvider();

    await runTurn(ports(provider.port), {
      sessionId: "ses-b1e2e",
      turnId: "trn-b1e2e",
      correlationId: "cor-b1e2e",
      text: "implement the flag parser",
      callerMessages: context.messages,
    });

    assert.equal(provider.seen.length, 1, "one request must have been sent");
    const sent = provider.seen[0];

    assert.ok(sent);
    assert.match(systemText(sent), /run `npm test` before claiming done/);
    assert.match(systemText(sent), /Project instructions from AGENTS\.md/);
  } finally {
    workspace.cleanup();
  }
});

test("the environment the run states is the real one, not a remembered one", async () => {
  const workspace = workspaceWith({
    "AGENTS.md": "house rules\n",
  });
  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context);
    const provider = recordingProvider();

    await runTurn(ports(provider.port), {
      sessionId: "ses-b1e2e",
      turnId: "trn-b1e2e",
      correlationId: "cor-b1e2e",
      text: "implement the flag parser",
      callerMessages: context.messages,
    });

    const sent = provider.seen[0];

    assert.ok(sent);
    const text = systemText(sent);

    // The workspace root the tools are confined to, named by the host that
    // confined them — not a path the model could have guessed or invented.
    assert.ok(
      text.includes(workspace.root),
      `the request must name the real workspace root; it said: ${text.slice(0, 400)}`,
    );
    assert.match(text, /platform: linux/);
    assert.match(text, /node: v22\.0\.0/);
  } finally {
    workspace.cleanup();
  }
});

test("a project's own rules are never dressed as a learned profile", async () => {
  const workspace = workspaceWith({
    "AGENTS.md": "Do not edit files under data/.\n",
  });
  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context);
    const provider = recordingProvider();

    await runTurn(ports(provider.port), {
      sessionId: "ses-b1e2e",
      turnId: "trn-b1e2e",
      correlationId: "cor-b1e2e",
      text: "implement the flag parser",
      callerMessages: context.messages,
    });

    const sent = provider.seen[0];

    assert.ok(sent);
    const text = systemText(sent);

    assert.match(text, /Do not edit files under data\//);
    // The three labels the Profile path would have worn. A rule wearing any of
    // them is a lie about where it came from, and its meaning changes the
    // moment someone turns the learning switch off.
    assert.doesNotMatch(text, /Trylo learned profile/);
    assert.doesNotMatch(text, /learned historical hints/);
    assert.doesNotMatch(text, /prompt_patch:/);
    assert.doesNotMatch(text, /user_rule:/);
  } finally {
    workspace.cleanup();
  }
});

test("a subdirectory rule reaches the request scoped to its own subtree", async () => {
  const workspace = workspaceWith({
    "AGENTS.md": "root rules\n",
    "src/AGENTS.md": "Every new module needs a test beside it.\n",
  });
  try {
    // Started in `src`, which is the case §3.1 calls out: a subdirectory run
    // still belongs to the root project.
    const context = projectContextFor(contextFor(join(workspace.root, "src")), workspace.root);

    assert.ok(context);
    const provider = recordingProvider();

    await runTurn(ports(provider.port), {
      sessionId: "ses-b1e2e",
      turnId: "trn-b1e2e",
      correlationId: "cor-b1e2e",
      text: "implement the flag parser",
      callerMessages: context.messages,
    });

    const sent = provider.seen[0];

    assert.ok(sent);
    const text = systemText(sent);

    assert.match(text, /root rules/);
    assert.match(text, /needs a test beside it/);
    // And the scope is stated, so a model can tell which subtree a rule governs
    // rather than reading every rule as applying to every file it opens.
    assert.match(text, /applies to the whole workspace/);
    assert.match(text, /applies to src\/ and below/);
  } finally {
    workspace.cleanup();
  }
});

test("the adopted source list names the file, its scope and its content hash", async () => {
  const workspace = workspaceWith({
    "AGENTS.md": "house rules\n",
    "src/AGENTS.md": "module rules\n",
  });
  try {
    const context = projectContextFor(contextFor(join(workspace.root, "src")), workspace.root);

    assert.ok(context);
    assert.deepEqual(
      context.sources.map((source) => [source.relativePath, source.scopePath, source.scope]),
      [
        ["AGENTS.md", ".", "workspace_root"],
        ["src/AGENTS.md", "src", "directory"],
      ],
    );

    // A hash per source: this is what a resume compares against to say the
    // rules changed without re-reading prose (WP §6).
    for (const source of context.sources) {
      assert.match(source.contentHash, /^[0-9a-f]{16}$/);
    }

    assert.notEqual(context.sources[0]?.contentHash, context.sources[1]?.contentHash);
    assert.deepEqual(context.problems, []);
  } finally {
    workspace.cleanup();
  }
});

/**
 * The absence case, and it is the one with teeth: a project with no rule file
 * must reach the request carrying nothing at all, which is the promise every
 * caller that never heard of a project rule depends on.
 */
test("a project with no rule file still receives environment facts without rule messages", async () => {
  const workspace = workspaceWith({ "src/index.ts": "export const x = 1;\n" });
  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context);
    assert.deepEqual(context.sources, []);
    assert.match(context.messages[0]?.content ?? "", /platform: linux/);

    const provider = recordingProvider();

    await runTurn(ports(provider.port), {
      sessionId: "ses-b1e2e",
      turnId: "trn-b1e2e",
      correlationId: "cor-b1e2e",
      text: "implement the flag parser",
    });
    const sent = provider.seen[0];

    assert.ok(sent);
    assert.doesNotMatch(systemText(sent), /Project instructions from/);
  } finally {
    workspace.cleanup();
  }
});
