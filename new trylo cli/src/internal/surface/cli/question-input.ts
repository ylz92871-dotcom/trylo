import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";
import { admitAnswer } from "../../domain/ask-user.js";

/** Actual terminal input enters the existing question owner, independently of permissions. */
export async function answerQuestionInput(questions: AskUserSession | undefined, text: string, readLine: (prompt?: string) => Promise<string | undefined>, requestId?: string): Promise<string> {
  const pending = questions?.pending() ?? [];
  const request = requestId === undefined ? pending.at(-1) : pending.find(item => item.requestId === requestId);
  if (questions === undefined || request === undefined) return text;

  const answers: Record<string, string> = Object.create(null);

  for (const [index, question] of request.questions.entries()) {
    const prompt = `[${question.header}] ${question.question}: `;
    let answer = index === 0 ? text : await readLine(prompt);

    for (;;) {
      if (answer === undefined || ["cancel", "/cancel"].includes(answer.trim().toLowerCase())) {
        questions.cancelRequest(request.requestId);
        return `User cancelled request ${request.requestId}${answer === undefined ? ": input closed" : ""}`;
      }

      const admission = admitAnswer(new Map([[request.requestId, request]]), request.requestId, { [question.id]: answer });
      if (admission.kind === "accepted") break;

      answer = await readLine(`${admission.message}\n${prompt}`);
    }

    answers[question.id] = answer;
  }

  const result = questions.answerFromUser(request.requestId, answers);
  if (result.outcome !== "result") throw new Error(`question_answer_refused: ${result.outcome === "error" ? result.message : result.outcome}`);

  return `User answer for request ${request.requestId}: ${JSON.stringify(answers)}\n${result.output}`;
}
