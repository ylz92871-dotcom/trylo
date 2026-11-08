import { DEFAULT_WIDTH } from "./frame.js";
import { markdownLines } from "./markdown.js";
import type { ToolCallFact } from "./state.js";
import type { TuiLine, TuiTone } from "./state.js";

/**
 * Waiting facts and their panels (WP23.3 / L44), split out of `state.ts`.
 *
 * The reducer only decides *whether* something is waiting; this module owns
 * what a wait means: how a call is recognised as a question or a plan, what
 * the wait names, and the visible panel a person reads. Everything here is a
 * pure function of the tool call and its result — the same input always
 * produces the same wait and the same rows, so a panel can be tested without
 * a terminal and the status bar cannot disagree with it.
 */

/**
 * Why the shell is not taking new work right now (WP23.3 / L44).
 *
 * Every variant is a fact an event said — a call opened and not closed, a
 * question the model asked, a plan the model submitted — never a guess about
 * what the loop might be doing. The question and the plan survive the turn
 * that asked for them (an async question outlives its turn by design), and
 * each names what the person can do about it: answer, approve, or cancel.
 */
export type WaitingReason =
  | { readonly kind: "tool"; readonly names: ReadonlyArray<string> }
  | {
      readonly kind: "question";
      readonly requestId: string | undefined;
      readonly questions: ReadonlyArray<AskUserQuestion>;
    }
  | { readonly kind: "plan"; readonly plan: string | undefined };

/** One question the model asked, exactly as the tool call carried it. */
export type AskUserQuestion = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
};

/** The two fields of a result the wait logic reads. */
export type ResultFact = {
  readonly name: string;
  readonly status: string;
  readonly output: string;
};

/** The tool names the question/plan panels are keyed on. */
const SYNC_ASK_TOOL = "ask_user_question";
const ASYNC_ASK_TOOL = "request_user_input_async";
const ANSWER_TOOL = "answer_user_question";
const PLAN_EXIT_TOOL = "exit_plan_mode";

/**
 * What a closed call does to the wait state.
 *
 * Three calls change it: a question the model asked replaces "waiting" with
 * the question itself, a submitted plan replaces it with the plan, and a
 * delivered answer clears the question it answers. Everything else leaves the
 * wait exactly as the in-flight bookkeeping left it.
 */
export function waitingAfterResult(
  waiting: WaitingReason | undefined,
  result: ResultFact,
  call: ToolCallFact | undefined,
): WaitingReason | undefined {
  if (result.status !== "success") {
    return waiting;
  }

  if (result.name === ANSWER_TOOL) {
    return undefined;
  }

  if (result.name === SYNC_ASK_TOOL || result.name === ASYNC_ASK_TOOL) {
    return { kind: "question", requestId: requestIdOf(result.output), questions: questionsOf(call) };
  }

  if (result.name === PLAN_EXIT_TOOL) {
    return { kind: "plan", plan: planOf(call) };
  }

  return waiting;
}

/** `question request ask-3 recorded:` — the adapter's one stable id carrier. */
function requestIdOf(output: string): string | undefined {
  const match = /^question request (\S+) recorded:/.exec(output.trim());
  return match?.[1];
}

/** The questions exactly as the call carried them, or none it cannot name. */
function questionsOf(call: ToolCallFact | undefined): ReadonlyArray<AskUserQuestion> {
  const raw = call?.input?.["questions"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: AskUserQuestion[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const header = record["header"];
    const question = record["question"];
    if (typeof header !== "string" || typeof question !== "string") {
      continue;
    }

    questions.push({
      id: typeof record["id"] === "string" ? record["id"] : header,
      header,
      question,
      options: optionsOf(record["options"]),
      multiSelect: record["multiSelect"] === true,
    });
  }

  return questions;
}

function optionsOf(raw: unknown): Array<{ label: string; description: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const options: Array<{ label: string; description: string }> = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (typeof record["label"] !== "string") {
      continue;
    }

    options.push({
      label: record["label"],
      description: typeof record["description"] === "string" ? record["description"] : "",
    });
  }

  return options;
}

/** The plan text exactly as the call carried it. */
function planOf(call: ToolCallFact | undefined): string | undefined {
  const plan = call?.input?.["plan"];
  return typeof plan === "string" && plan.length > 0 ? plan : undefined;
}

/**
 * The visible panel a waiting call puts on screen.
 *
 * The wait state is one thing the status bar can abbreviate; the panel is the
 * thing a person reads. Both come from the same call, so what the bar
 * summarises and what the panel shows cannot disagree.
 */
const MAX_PANEL_QUESTIONS = 4;
const MAX_PANEL_PLAN_LINES = 12;

function lineOf(tone: TuiTone, text: string): TuiLine {
  return { tone, text };
}

export function panelLinesFor(result: ResultFact, call: ToolCallFact | undefined): ReadonlyArray<TuiLine> {
  if (result.status !== "success") {
    return [];
  }

  if (result.name === SYNC_ASK_TOOL || result.name === ASYNC_ASK_TOOL) {
    return questionPanelLines(questionsOf(call));
  }

  if (result.name === PLAN_EXIT_TOOL) {
    return planPanelLines(planOf(call));
  }

  return [];
}

function questionPanelLines(questions: ReadonlyArray<AskUserQuestion>): ReadonlyArray<TuiLine> {
  const shown = questions.slice(0, MAX_PANEL_QUESTIONS);
  if (shown.length === 0) {
    return [];
  }

  const lines: TuiLine[] = [lineOf("tool", "? awaiting your answer")];

  for (const question of shown) {
    lines.push(lineOf("strong", `  [${question.header}] ${question.question}`));

    for (const [index, option] of question.options.entries()) {
      lines.push(
        lineOf(
          "assistant",
          `    ${index + 1}. ${option.label}${option.description.length > 0 ? ` — ${option.description}` : ""}`,
        ),
      );
    }

    if (question.multiSelect) {
      lines.push(lineOf("system", "    (multiple choices allowed)"));
    }
  }

  lines.push(lineOf("system", "  type your answers; they are recorded for the model"));

  return lines;
}

function planPanelLines(plan: string | undefined): ReadonlyArray<TuiLine> {
  if (plan === undefined) {
    return [];
  }

  const rendered = markdownLines(plan, DEFAULT_WIDTH);
  const shown = rendered.slice(0, MAX_PANEL_PLAN_LINES);
  const hidden = rendered.length - shown.length;

  return [
    lineOf("tool", "? plan awaiting approval:"),
    ...shown.map((line) => ({ tone: line.tone, text: `  ${line.text}` })),
    ...(hidden > 0 ? [lineOf("system", `  … ${hidden} more plan lines`)] : []),
    lineOf("system", "  reply to approve or ask for changes; workspace edits stay blocked until then"),
  ];
}
