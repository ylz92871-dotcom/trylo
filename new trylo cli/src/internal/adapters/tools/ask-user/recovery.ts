import { admitAnswer, validateAskUserInput, type AskUserRequest } from "../../../domain/ask-user.js";
import type { Transcript, TranscriptItem } from "../../../protocol/transcript.js";

/** Rebuild this projection from the authoritative transcript; never create another journal. */
export function restoreQuestions(transcript: Transcript): ReadonlyArray<AskUserRequest> {
  const calls = new Map<string, Extract<TranscriptItem, { kind: "tool_call" }>>();
  const requests = new Map<string, AskUserRequest>();

  for (const item of transcript) {
    if (item.kind === "tool_call") calls.set(item.toolCallId, item);

    if (item.kind === "tool_result" && item.outcome === "succeeded" && ["ask_user_question", "request_user_input_async"].includes(item.name)) {
      const call = calls.get(item.toolCallId);
      const id = /^question request (\S+) recorded:/.exec(item.output)?.[1];
      const parsed = call === undefined ? undefined : validateAskUserInput(call.arguments);
      if (id !== undefined && parsed?.ok === true) requests.set(id, { requestId: id, questions: parsed.questions, status: "pending" });
    }

    if (item.kind !== "user") continue;

    const answer = /^User answer for request (\S+): ([^\n]+)\n/.exec(item.text);
    if (answer?.[1] !== undefined && answer[2] !== undefined) {
      try {
        const raw: unknown = JSON.parse(answer[2]);
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.values(raw).every(value => typeof value === "string")) {
          const result = admitAnswer(requests, answer[1], raw as Record<string, string>);
          if (result.kind === "accepted" && Object.keys(result.request.answers ?? {}).length === result.request.questions.length) requests.set(answer[1], result.request);
        }
      } catch { /* Ordinary user prose is never promoted into an answer fact. */ }
    }

    const cancelled = /^User cancelled request (\S+)$/.exec(item.text.replace(/: input closed$/, ""))?.[1];
    const request = cancelled === undefined ? undefined : requests.get(cancelled);
    if (request !== undefined) requests.set(request.requestId, { ...request, status: "cancelled" });
  }

  return [...requests.values()].filter(request => request.status === "pending").concat([...requests.values()].filter(request => request.status !== "pending").slice(-64));
}
