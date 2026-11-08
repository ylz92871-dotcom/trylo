import { isTranscriptItem, type Transcript } from "../protocol/transcript.js";
import type { SessionRecord } from "../ports/session.js";
import { nextTranscriptSequence } from "./transcript-messages.js";
import type { ProviderMessage, ProviderRequest, ProviderToolSpec, SystemPromptDirective } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolPort } from "../ports/tools.js";
import type { MethodSlotMessage } from "./method-port.js";
import type { PromptContext } from "./compact-boundary.js";
import { promptViewMessages as promptMessages } from "./prompt-view.js";
import { finalReportInstructions } from "./budget-final-report.js";
import { interruptionReportInstructions, type InterruptionReport } from "./report-instructions.js";

/**
 * Building the next provider request.
 *
 * Two facts meet here and nowhere else: which history the model is allowed to
 * see — the compaction boundary decides that — and what the tool catalog looks
 * like on the wire. The runner only supplies the view.
 */

/**
 * The profile-derived (system) messages for a turn.
 *
 * Only these are assembled up front. The user turn becomes a canonical
 * transcript item, so the transcript alone is enough to rebuild a request after
 * a restart — and nothing here is re-read once the turn is running.
 */
export function seedMessagesOf(
  assembled: ReadonlyArray<{ readonly role: ProviderMessage["role"]; readonly content: string }>,
): ReadonlyArray<ProviderMessage> {
  return assembled.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * The transcript this turn works from: whatever was resumed, plus the user turn.
 *
 * The user's own words become a canonical item rather than a message built at
 * request time, which is what lets a restart rebuild the conversation from the
 * transcript alone.
 */
export function resumedTranscriptFor(resumed: Transcript | undefined, text: string, records?: ReadonlyArray<SessionRecord>): Transcript {
  const base: Transcript = resumed ?? [];
  let sequence = nextTranscriptSequence(base);

  // A read projection may omit an unanswered request. Its durable ordinal is
  // still occupied, so only the raw journal can supply the restart high-water.
  for (const record of records ?? []) {
    if (record.type === "transcript_item" && isTranscriptItem(record.payload)) {
      sequence = Math.max(sequence, record.payload.sequence + 1);
    }
  }

  return [...base, { kind: "user", sequence, text }];
}

export type RequestView = {
  readonly attemptId: string | undefined;
  readonly continuationScope?: string;
  readonly model: string;
  readonly finalReport?: "budget_limit" | InterruptionReport;
  readonly tools: ToolPort;
  readonly prompt: PromptContext;
  /**
   * The output budget for this request, when the caller set one
   * (`--max-tokens` → `IterationBudget.maxOutputTokens`). Absent means the
   * provider decides its own limit, exactly as before this field existed.
   * Carried here (rather than re-read from a budget elsewhere) so the request
   * states what the adapter must send.
   */
  readonly maxOutputTokens?: number;
  /**
   * The method slot this request may carry, if the board compiled one for this
   * beat. Absent — which includes learning off, an empty archive, no match, or
   * every candidate dormant — means the messages are exactly the ones the
   * un-wired path builds.
   */
  readonly slot?: MethodSlotMessage;
  /**
   * The tool-gap self-report prompt for this beat, if the awareness layer asked
   * for one (P05 tool learning §2 source ③).
   *
   * A second `system` segment rather than a field of the method slot, because
   * the two subsystems are independent: a beat can carry a self-report request
   * with no method slot at all, and vice versa. Absent is the identity case, so
   * the un-wired path is unchanged by construction.
   */
  readonly toolGapSlot?: MethodSlotMessage;
  /**
   * A caller-supplied system prompt (`--system-prompt` replace or
   * `--append-system-prompt` append, legacy L67). Applied to the assembled
   * seeds before the tool list is inserted, so ordering (seeds, tool list,
   * conversation) cannot drift. Absent means the messages are exactly the
   * ones the un-wired path builds.
   */
  readonly systemPrompt?: SystemPromptDirective;
  /**
   * Text appended as a system message after the seeds. Applied after
   * `systemPrompt`, so `--system-prompt` + `--append-system-prompt` compose
   * in legacy order (replace the seeds, then append). Absent means nothing
   * is appended.
   */
  readonly systemPromptAppend?: string;
  /**
   * JSON Schema the final answer must satisfy (WP18.3: C74). Carried here so
   * the request states what the adapter must send; absent means the provider
   * decides its own shape, exactly as before this field existed.
   */
  readonly responseSchema?: JsonObject;
};

export function buildRequest(view: RequestView): ProviderRequest {
  const messages = requestMessages(promptMessages(view.prompt), view.prompt.seedMessages.length, view);
  return {
    attemptId: view.attemptId ?? "att-unknown",
    ...(view.continuationScope === undefined ? {} : { continuationScope: view.continuationScope }),
    model: view.model,
    // A runtime output request, not a new human input or security policy.
    // Keep it recent on every wire: Anthropic and some Chat templates fold
    // system segments to the head. Governing rules stay in system messages;
    // the report-only ToolPort, not message-role authority, forbids actions.
    messages: view.finalReport === undefined ? messages
      : [...messages, { role: "user", content: view.finalReport === "budget_limit"
        ? finalReportInstructions(view.prompt.transcript, view.slot === undefined && view.toolGapSlot === undefined ? "report" : "report_and_auxiliary")
        : interruptionReportInstructions(view.prompt.transcript, view.finalReport,
          view.slot === undefined && view.toolGapSlot === undefined ? "report" : "report_and_auxiliary") }],
    tools: toolSpecs(view.tools),
    ...(view.maxOutputTokens === undefined ? {} : { maxOutputTokens: view.maxOutputTokens }),
    ...(view.responseSchema === undefined ? {} : { responseSchema: view.responseSchema }),
    ...(view.systemPrompt === undefined ? {} : { systemPrompt: view.systemPrompt }),
    ...(view.systemPromptAppend === undefined ? {} : { systemPromptAppend: view.systemPromptAppend }),
  };
}

/** A provider response boundary does not end the user's task or create a new user turn. */
export function continuationAppend(finishReason: string, append: string | undefined): string | undefined {
  if (finishReason !== "length") return append;
  const instruction = "The previous response reached the provider's per-response output limit. "
    + "Continue the same original task from the recorded text and completed tool results. "
    + "Do not repeat completed actions or restart the task. Tool calls in the truncated response were not executed; "
    + "reissue any still-needed unexecuted call with complete arguments. Finish when the original task is actually complete.";
  return append === undefined || append.trim().length === 0 ? instruction : `${append}\n\n${instruction}`;
}

/** Request decoration shared by the sender and its context budget. */
export function requestMessages(
  messages: ReadonlyArray<ProviderMessage>,
  seedCount: number,
  options: {
    readonly tools?: ToolPort;
    readonly systemPrompt?: SystemPromptDirective;
    readonly systemPromptAppend?: string;
    readonly slot?: MethodSlotMessage;
    readonly toolGapSlot?: MethodSlotMessage;
  },
): ReadonlyArray<ProviderMessage> {
  const prompted = applySystemPrompt(messages, seedCount, options.systemPrompt);
  const appended = applySystemPromptAppend(prompted.messages, prompted.seedCount, options.systemPromptAppend);
  return withInjectedSlot(options.tools === undefined ? appended.messages
    : withToolList(appended.messages, options.tools, appended.seedCount), options.slot, options.toolGapSlot);
}

/**
 * Apply a caller system prompt to already-assembled messages.
 *
 * `replace` drops the assembled seed system messages and installs exactly
 * one; `append` adds one system message after the seeds. The tool-list
 * insertion counts from the returned seed count, so the list still lands
 * between seeds and conversation. Blank text is identity: a flag that only
 * carried whitespace must not rewrite the seeds.
 */
function applySystemPrompt(
  messages: ReadonlyArray<ProviderMessage>,
  seedCount: number,
  directive: SystemPromptDirective | undefined,
): { readonly messages: ReadonlyArray<ProviderMessage>; readonly seedCount: number } {
  if (directive === undefined) {
    return { messages, seedCount };
  }

  if (directive.text.trim().length === 0) {
    return { messages, seedCount };
  }

  const extra: ProviderMessage = { role: "system", content: directive.text };

  if (directive.mode === "replace") {
    return { messages: [extra, ...messages.slice(seedCount)], seedCount: 1 };
  }

  return { messages: [...messages.slice(0, seedCount), extra, ...messages.slice(seedCount)], seedCount: seedCount + 1 };
}

/**
 * Append a caller system message after the seeds. Runs after the replace
 * step, so the two flags compose in legacy order; blank or absent text is
 * identity.
 */
function applySystemPromptAppend(
  messages: ReadonlyArray<ProviderMessage>,
  seedCount: number,
  text: string | undefined,
): { readonly messages: ReadonlyArray<ProviderMessage>; readonly seedCount: number } {
  if (text === undefined || text.trim().length === 0) {
    return { messages, seedCount };
  }
  const extra: ProviderMessage = { role: "system", content: text };
  return { messages: [...messages.slice(0, seedCount), extra, ...messages.slice(seedCount)], seedCount: seedCount + 1 };
}

/**
 * The run's tool table, stated in words (opencode/gemini carry the same
 * `<available_tools>`-shaped segment beside the function definitions).
 *
 * Function definitions alone did not stop models from calling tools that are
 * not mounted or never approved — the refusal then fails the turn. The list
 * names exactly the mounted table (MCP tools included, by qualified name) and
 * marks what needs approval, so "call something else" reads as a refusal in
 * advance rather than a discovery after the fact.
 *
 * It rides *ahead* of the method and tool-gap slots, so those stay last (their
 * order is pinned by contract tests), and it is absent — not empty — when the
 * catalog cannot be read or holds nothing, exactly like the slots it precedes.
 */
export function toolListMessage(tools: ToolPort): ProviderMessage | undefined {
  let bindings;

  try {
    bindings = tools.snapshot();
  } catch {
    return undefined;
  }

  if (bindings.length === 0) {
    return undefined;
  }

  const names = bindings.map((binding) =>
    binding.needsApproval ? `${binding.name} (needs approval)` : binding.name,
  );

  return {
    role: "system",
    content: [
      `Available tools this run: ${names.join(", ")}.`,
      "Only these tools exist: a call to any other name is refused.",
      "A call marked needs approval runs only after it is approved — an unapproved call fails the turn.",
    ].join("\n"),
  };
}

/** Inserts the tool list after the seed messages, or returns the list untouched. */
function withToolList(
  messages: ReadonlyArray<ProviderMessage>,
  tools: ToolPort,
  seedCount: number,
): ReadonlyArray<ProviderMessage> {
  const list = toolListMessage(tools);
  if (list === undefined) {
    return messages;
  }

  // System statements stay ahead of the conversation: the list joins the seed
  // and the summary, never the user turn it would otherwise bury.
  return [...messages.slice(0, seedCount), list, ...messages.slice(seedCount)];
}

/**
 * Appends the method slot, or returns the list untouched.
 *
 * With no slot this is the identity function — the same array, not a copy — so
 * "learning off" and "learning on with nothing compiled" both produce requests
 * byte-identical to the un-wired path by construction rather than by agreement
 * (I1). This is the one place a learned sentence is allowed to reach a provider
 * request, and it is a `system` message because what the slot says is neither
 * something the user said nor something the assistant said: it talks *about*
 * the conversation, like the compaction summary it rides beside.
 *
 * The lease is one request. Nothing here remembers a slot; the caller gets it
 * from a port that only answers for the turn currently running.
 */
export function withInjectedSlot(
  messages: ReadonlyArray<ProviderMessage>,
  slot: MethodSlotMessage | undefined,
  toolGapSlot?: MethodSlotMessage,
): ReadonlyArray<ProviderMessage> {
  if (slot === undefined && toolGapSlot === undefined) {
    return messages;
  }
  return [...messages, ...(slot === undefined ? [] : [slot]), ...(toolGapSlot === undefined ? [] : [toolGapSlot])];
}

/**
 * A throwing catalog must not take the run down: an empty tool list fails
 * closed (no tool can be called) instead of crashing, and the degradation is
 * reported by `readToolApprovalRequirement` on the tool path. The same reading
 * names the tools for the slot, so an unreadable catalog simply offers no
 * candidate a tool name to match on.
 */
export function toolSpecs(tools: ToolPort): ReadonlyArray<ProviderToolSpec> {
  try {
    return tools.snapshot().map((binding) => ({
      name: binding.name,
      description: binding.description,
      parameters: binding.parameters,
    }));
  } catch {
    return [];
  }
}
