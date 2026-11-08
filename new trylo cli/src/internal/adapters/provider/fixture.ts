import type {
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ProviderUsage,
} from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";

/**
 * Deterministic provider for offline acceptance.
 *
 * The script is derived from the request, not from a wall clock or a counter of
 * calls alone: each stage is recognised by the *tool result it carries*. If the
 * loop failed to feed the tool result back, the fixture would ask again instead
 * of answering — so a broken feedback loop cannot look like success.
 *
 * The mutating script goes one step further and *reads the file back* before it
 * answers. Nothing about the final sentence is written down in advance: it is
 * built from whatever the workspace actually contains at that moment, so a
 * write that never reached the disk produces a sentence about failure.
 */

export type FixtureVerificationStep = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArguments: Readonly<Record<string, string>>;
};

export type FixtureScript = {
  readonly providerId: string;
  readonly toolName: string;
  readonly toolArguments: Readonly<Record<string, string>>;
  readonly toolCallId: string;
  /** Optional read-back stage: proof that the previous call changed the disk. */
  readonly verify?: FixtureVerificationStep;
};

export const DEFAULT_FIXTURE_SCRIPT: FixtureScript = {
  providerId: "fixture",
  toolName: "read_file",
  toolArguments: { path: "package.json" },
  toolCallId: "fx-call-1",
};

export const WRITE_FIXTURE_PATH = "fixture-output.txt";
export const WRITE_FIXTURE_CONTENT = "the fixture wrote this line";

export const WRITE_FIXTURE_SCRIPT: FixtureScript = {
  providerId: "fixture-write",
  toolName: "write_file",
  toolArguments: { path: WRITE_FIXTURE_PATH, content: WRITE_FIXTURE_CONTENT },
  toolCallId: "fx-write-1",
  verify: {
    toolCallId: "fx-read-1",
    toolName: "read_file",
    toolArguments: { path: WRITE_FIXTURE_PATH },
  },
};

export const SUBAGENT_FIXTURE_SCRIPT: FixtureScript = {
  providerId: "fixture-subagent",
  toolName: "delegate_subagent",
  toolArguments: {
    taskName: "inspect_workspace",
    prompt: "inspect workspace package.json",
  },
  toolCallId: "fx-sa-1",
};

/**
 * Offline acceptance for the formal user-memory path (WP-CL / B).
 *
 * Two stages, chosen by what the person asked, and every final sentence is
 * built from the tool result the run actually got back:
 *
 *  - "请记住 …"   → `memory_remember`, then the answer quotes the receipt;
 *  - anything else → `memory_search`, then the answer quotes the hits.
 *
 * That is the whole point of this fixture: the second process can only answer
 * "你是 YL Z" if the first process really wrote the fact to the ledger. The
 * sentence is not stored anywhere in advance, and the workspace contains no
 * such text, so a passing run cannot be a coincidence.
 */
export const MEMORY_FIXTURE_REMEMBER_CALL = "fx-remember-1";
export const MEMORY_FIXTURE_SEARCH_CALL = "fx-search-1";

function lastUserText(messages: ProviderRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function toolOutput(messages: ProviderRequest["messages"], toolCallId: string): string | undefined {
  return messages.find((message) => message.role === "tool" && message.toolCallId === toolCallId)?.content;
}

function quote(text: string, limit = 400): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export function createMemoryFixtureProvider(): ProviderPort {
  return {
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      yield { type: "stream_start", providerId: "fixture-memory", model: request.model, warnings: [] };
      const userText = lastUserText(request.messages);
      if (/记住|remember/iu.test(userText)) {
        const receipt = toolOutput(request.messages, MEMORY_FIXTURE_REMEMBER_CALL);
        if (receipt === undefined) {
          yield* callTool(signal, MEMORY_FIXTURE_REMEMBER_CALL, "memory_remember", {
            subject: "YL Z",
            statement: userText.trim(),
            fact_kind: "identity_fact",
            scope: "user",
          });
          return;
        }

        yield* answer(`保存回执：${quote(receipt)}`, signal);

        return;
      }

      const hits = toolOutput(request.messages, MEMORY_FIXTURE_SEARCH_CALL);
      if (hits === undefined) {
        yield* callTool(signal, MEMORY_FIXTURE_SEARCH_CALL, "memory_search", { queries: ["YL Z"] });
        return;
      }

      yield* answer(`记忆检索结果：${quote(hits)}`, signal);
    },
  };
}

function usage(input: number, output: number): ProviderUsage {
  return { ...emptyUsage("snapshot"), inputTokens: input, outputTokens: output, totalTokens: input + output };
}

async function* callTool(
  signal: AbortSignal,
  toolCallId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): AsyncIterable<ProviderEvent> {
  const rawArguments = JSON.stringify(args);

  yield { type: "tool_input_start", toolCallId, name };

  for (const chunk of rawArguments.match(/.{1,8}/gs) ?? []) {
    if (signal.aborted) {
      yield { type: "cancel_ack" };
      return;
    }
    yield { type: "tool_input_delta", toolCallId, argumentsText: chunk };
  }

  yield { type: "tool_input_end", toolCallId };
  yield { type: "usage", usage: usage(16, 8) };
  yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
}

async function* answer(
  text: string,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const blockId = "fx-text-1";

  yield { type: "text_start", blockId };

  for (const chunk of text.match(/.{1,12}/gs) ?? []) {
    if (signal.aborted) {
      yield { type: "cancel_ack" };
      return;
    }
    yield { type: "text_delta", blockId, text: chunk };
  }

  yield { type: "text_end", blockId };
  yield { type: "usage", usage: usage(32, 12) };
  yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
}

export function createFixtureProvider(script: FixtureScript = DEFAULT_FIXTURE_SCRIPT): ProviderPort {
  return {
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      yield {
        type: "stream_start",
        providerId: script.providerId,
        model: request.model,
        warnings: [],
      };
      const hasCompacted = request.messages.some(
        (m) => m.role === "system" && m.content.includes("[compacted history"),
      );
      const toolResult = request.messages.find((message) => message.role === "tool");
      if (toolResult === undefined && !hasCompacted) {
        yield* callTool(signal, script.toolCallId, script.toolName, script.toolArguments);
        return;
      }

      if (script.verify !== undefined) {
        const verified = request.messages.find(
          (message) => message.role === "tool" && message.toolCallId === script.verify?.toolCallId,
        );
        if (verified === undefined) {
          yield* callTool(
            signal,
            script.verify.toolCallId,
            script.verify.toolName,
            script.verify.toolArguments,
          );
          return;
        }

        yield* answer(describeVerifiedWrite(String(script.toolArguments["path"] ?? ""), verified.content), signal);

        return;
      }

      if (script.providerId === "fixture-subagent") {
        yield* answer(`Subagent finished: ${toolResult?.content ?? "done"}`, signal);
        return;
      }

      const blockId = "fx-text-1";

      yield { type: "text_start", blockId };
      yield { type: "text_delta", blockId, text: "The package name is " };
      const sourceText =
        toolResult?.content ??
        request.messages.find((m) => m.role === "system" && m.content.includes("[compacted history"))?.content ??
        "";
      const name = /"name"\s*:\s*"([^"]+)"/.exec(sourceText)?.[1] ?? "unknown";

      yield { type: "text_delta", blockId, text: `${name}.` };
      yield { type: "text_end", blockId };
      yield { type: "usage", usage: usage(32, 12) };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
}

/**
 * The answer quotes what the read-back found. A failed read is reported as a
 * failure rather than paraphrased into something that sounds like success: this
 * fixture is the one place in the demo allowed to classify text, and it errs
 * towards calling things broken.
 */
const FAILURE_MARKERS: ReadonlyArray<string> = [
  "_failed",
  "cancelled",
  "invalid_",
  "path_outside_workspace",
  "path_escapes_via_link",
  "path_unverifiable",
  "parent_missing",
  "file_missing",
  "write_too_large",
  "sandbox_",
  "unknown_tool",
  "denied",
];

function describeVerifiedWrite(path: string, content: string): string {
  const trimmed = content.trim();
  const failed = trimmed.length === 0 || FAILURE_MARKERS.some((marker) => trimmed.includes(marker));
  return failed
    ? `The write did not land; reading ${path} back reported: ${trimmed}`
    : `The workspace file ${path} now contains: ${trimmed}`;
}
