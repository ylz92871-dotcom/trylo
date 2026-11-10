import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import {
  admitAnswer,
  renderAnswers,
  validateAskUserInput,
  type AskUserRequest,
} from "../../../domain/ask-user.js";

/**
 * Structured user questions (WP21.1: C29/L22 sync, C30 async).
 *
 * Two calls, one lifecycle:
 *
 * - `ask_user_question {questions}` — the model asks. Validation first;
 *   a refused call creates nothing. Success returns a `requestId` the
 *   surface (WP23 TUI) prompts with. The answer is *not* in this result.
 * - `answer_user_question {requestId, answers}` — the user's words arrive.
 *   Unknown, already-settled, or mismatched answers are rejected, never
 *   merged. Success renders `question -> answer` lines the next model turn
 *   consumes as ordinary input.
 *
 * Answers are evidence, never authorisation: both bindings are `read_only`
 * and approval-free, and no answer ever mints a permission grant. The model
 * calling `answer_user_question` for its own request is a protocol violation
 * the surface must prevent (WP23 owns the prompt); until then the rejection
 * of late and duplicate answers is what keeps a stale turn from rewriting a
 * live one.
 *
 * Async (`request_user_input_async`, `send_message_to_user_async`) rides the
 * same store: the model asks and continues; the reply arrives later through
 * `answer_user_question` or the run's input queue (WP08). Sync callers wait;
 * async callers do not — the store does not enforce the difference, the loop
 * does.
 */

const ASK_BINDING: ToolBinding = {
  name: "ask_user_question",
  description:
    "Ask the user when a needed preference, account or constraint cannot be inferred. Ask 1-4 concise questions; omit options for free text, or offer 2-4 choices with the recommended one first. Do useful independent work while awaiting an asynchronous answer. Answers are input, never permission for a side effect.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable snake_case id. Derived from the header when absent." },
            header: { type: "string", maxLength: 12 },
            question: { type: "string", maxLength: 500 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: 120 },
                  description: { type: "string", maxLength: 500 },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: { type: "boolean" },
          },
          required: ["header", "question"],
        },
      },
    },
    required: ["questions"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const ANSWER_BINDING: ToolBinding = {
  name: "answer_user_question",
  description:
    "Deliver the user's answer for one ask_user_question requestId. Rejects unknown, already-settled, and mismatched answers. Carries input only, never a permission grant.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      answers: {
        type: "object",
        description: "Map of question id (or exact question text) to the user's answer. Multi-select answers are comma-separated.",
      },
    },
    required: ["requestId", "answers"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const ASYNC_BINDING: ToolBinding = {
  name: "request_user_input_async",
  description:
    "Ask 1-4 questions without ending the turn. Returns a requestId immediately; the reply arrives later via answer_user_question or the run input queue. Same validation as ask_user_question.",
  sideEffect: "read_only",
  parameters: ASK_BINDING.parameters,
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const SEND_MESSAGE_BINDING: ToolBinding = {
  name: "send_message_to_user_async",
  description:
    "Send one out-of-band message to the user without waiting for a reply. The reply, if any, arrives as a new user message naming no requestId.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", maxLength: 4000 },
    },
    required: ["message"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

export type AskUserPortOptions = {
  readonly surfaceAnswersOnly?: boolean;
  readonly restored?: ReadonlyArray<AskUserRequest>;
  /** Override the request id generator in tests. Production default counts up. */
  readonly nextRequestId?: () => string;
};

export type AskUserSession = ToolPort & {
  readonly pending: () => ReadonlyArray<AskUserRequest>;
  readonly answerFromUser: (requestId: string, answers: JsonObject) => ToolOutcome;
  readonly cancelRequest: (requestId: string) => void;
  readonly close: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

export function createAskUserTools(options: AskUserPortOptions = {}): AskUserSession {
  const requests = new Map<string, AskUserRequest>((options.restored ?? []).map(request => [request.requestId, request]));
  let counter = 0;
  const nextId = options.nextRequestId ?? (() => {
    counter += 1;
    return `ask-${counter}`;
  });

  function ask(call: ToolCallRequest, asyncRequest: boolean): ToolOutcome {
    const validated = validateAskUserInput(call.arguments);
    if (validated.ok === false) {
      return { outcome: "error", code: "invalid_arguments", message: validated.message };
    }

    if ([...requests.values()].filter(request => request.status === "pending").length >= 64) {
      return { outcome: "error", code: "too_many_requests", message: "too many pending user questions; answer or cancel one first" };
    }

    const requestId = nextId();
    const request: AskUserRequest = { requestId, questions: validated.questions, status: "pending" };

    requests.set(requestId, request);

    // Retain bounded tombstones for duplicate/late refusal without starving new asks.
    for (const [id, prior] of requests) {
      if (requests.size <= 128) break;
      if (prior.status !== "pending") requests.delete(id);
    }

    const lines = validated.questions.map(
      (item) => `- [${item.id}] ${item.header}: ${item.question} (${item.options.map((option) => option.label).join(" / ")})${item.multiSelect ? " [multi]" : ""}`,
    );
    const hint = asyncRequest
      ? "async request recorded; continue working, the reply arrives later"
      : "await the user's answer via answer_user_question; do not proceed as if answered";

    return {
      outcome: "result",
      value: {
        requestId,
        status: "awaiting_answer",
        questions: validated.questions.map((item) => ({
          id: item.id,
          header: item.header,
          question: item.question,
          options: item.options.map((option) => ({ label: option.label, description: option.description })),
          multiSelect: item.multiSelect,
        })),
      },
      output: `question request ${requestId} recorded:\n${lines.join("\n")}\n${hint}`,
      truncated: false,
    };
  }

  function answer(call: ToolCallRequest): ToolOutcome {
    const rawId = call.arguments["requestId"];
    const rawAnswers = call.arguments["answers"];

    if (typeof rawId !== "string" || rawId.length === 0) {
      return { outcome: "error", code: "invalid_arguments", message: "requestId must be a non-empty string" };
    }

    if (isRecord(rawAnswers) === false) {
      return { outcome: "error", code: "invalid_arguments", message: "answers must be an object of question id to answer string" };
    }

    const answers: Record<string, string> = Object.create(null);

    for (const [key, value] of Object.entries(rawAnswers)) {
      if (typeof value !== "string") {
        return { outcome: "error", code: "invalid_arguments", message: `answer for "${key}" must be a string` };
      }
      answers[key] = value;
    }

    const admission = admitAnswer(requests, rawId, answers);
    if (admission.kind === "rejected") {
      const code = admission.reason === "already_settled" ? "late_answer_rejected"
        : admission.reason === "unknown_request" ? "unknown_request"
        : "invalid_answer";
      return { outcome: "error", code, message: admission.message };
    }

    if (Object.keys(admission.request.answers ?? {}).length !== admission.request.questions.length) {
      return { outcome: "error", code: "invalid_answer", message: "answer every question before settling this request" };
    }

    requests.set(rawId, admission.request);

    return {
      outcome: "result",
      value: {
        requestId: rawId,
        status: "answered",
        answers: admission.request.answers ?? {},
      },
      output: renderAnswers(admission.request),
      truncated: false,
    };
  }

  return {
    pending: () => [...requests.values()].filter(request => request.status === "pending"),
    answerFromUser: (requestId, answers) => answer({ name: "answer_user_question", toolCallId: `user:${requestId}`, arguments: { requestId, answers } }),
    cancelRequest(requestId) {
      const request = requests.get(requestId);
      if (request?.status === "pending") requests.set(requestId, { ...request, status: "cancelled" });
    },
    close() { for (const [id, request] of requests) if (request.status === "pending") requests.set(id, { ...request, status: "cancelled" }); },
    snapshot() {
      return [ASK_BINDING, ANSWER_BINDING, ASYNC_BINDING, SEND_MESSAGE_BINDING];
    },
    async execute(call: ToolCallRequest, _signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name === "ask_user_question") {
        return ask(call, false);
      }

      if (call.name === "request_user_input_async") {
        return ask(call, true);
      }

      if (call.name === "answer_user_question") {
        if (options.surfaceAnswersOnly === true) return { outcome: "error", code: "user_answer_required", message: "only the terminal may submit an actual user's answer; wait for user input" };
        return answer(call);
      }

      if (call.name === "send_message_to_user_async") {
        const message = call.arguments["message"];
        if (typeof message !== "string" || message.trim().length === 0) {
          return { outcome: "error", code: "invalid_arguments", message: "message must be a non-empty string" };
        }

        return {
          outcome: "result",
          value: { delivered: true },
          output: `message queued for the user: ${message.slice(0, 280)}`,
          truncated: message.length > 280,
        };
      }

      return { outcome: "unknown", code: "unknown_tool", message: `ask-user port does not have ${call.name}` };
    },
    async cancel(): Promise<void> {
      // No async work to stop: asking and answering are synchronous records.
    },
  };
}
