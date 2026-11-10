import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { StdioSession } from "./stdio-session.js";
import type { AskUserRequest } from "../../domain/ask-user.js";
import type { ToolOutcome } from "../../ports/tools.js";

async function waitForAnswer(owner: AskUserSession, pending: AskUserRequest, channel: StdioSession, signal: AbortSignal): Promise<ToolOutcome> {
  while (!signal.aborted) {
    const reply = await channel.question(pending, signal);
    if (reply === undefined || reply.status === "dismissed") {
      owner.cancelRequest(pending.requestId);
      return { outcome: "error", code: "user_input_cancelled", message: "The user question was cancelled; no answer was supplied." };
    }

    const answers = reply.answers;
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) continue;

    const answered = owner.answerFromUser(pending.requestId, answers as JsonObject);
    if (answered.outcome === "result") return { ...answered,
      output: `User answer for request ${pending.requestId}: ${JSON.stringify(answers)}\n${answered.output}` };
  }
  owner.cancelRequest(pending.requestId);
  return { outcome: "cancelled" };
}

/** Resume old unanswered requests without introducing a second stdin reader. */
export async function answerStdioInput(owner: AskUserSession | undefined, channel: StdioSession, text: string, signal: AbortSignal): Promise<string> {
  const pending = owner?.pending().at(-1);
  if (!owner || !pending) return text;
  const result = await waitForAnswer(owner, pending, channel, signal);
  return result.outcome === "result" ? `${result.output}\n\n${text}` : `User cancelled request ${pending.requestId}`;
}

/** Reuses the question owner and validation; only the Desktop transport waits here. */
export function stdioQuestions(owner: AskUserSession, channel: StdioSession): AskUserSession {
  return {
    ...owner,
    snapshot: () => owner.snapshot().map(binding => binding.name === "ask_user_question"
      ? { ...binding, timeoutMs: undefined, description: binding.description + " The host waits for the user's actual answer or explicit cancellation; never answer on the user's behalf." } : binding),

    async execute(call, signal) {
      const issued = await owner.execute(call, signal);
      if (!["ask_user_question", "request_user_input_async"].includes(call.name) || issued.outcome !== "result") return issued;

      const requestId = issued.value?.["requestId"];
      const pending = owner.pending().find(item => item.requestId === requestId);
      if (!pending) return issued;

      if (call.name === "request_user_input_async") {
        void waitForAnswer(owner, pending, channel, channel.signal).then(answered => {
          if (answered.outcome === "result") channel.enqueue(answered.output);
        }).catch(() => { owner.cancelRequest(pending.requestId); });
        return issued;
      }

      return waitForAnswer(owner, pending, channel, signal);
    },
  };
}
