import type { JsonObject } from "../protocol/envelope.js";

/**
 * Structured user questions (WP21.1: C29/L22 sync + C30 async).
 *
 * Canonical owner: UserInputPort. One request, one lifecycle owner, one
 * write entry. The model asks; the user answers; the answer re-enters the
 * run as a tool result, never as a permission grant.
 *
 * Mechanical reuse, not a rewrite:
 * - Old CLI `AskUserQuestion` (1-4 questions, 2-4 options, unique texts and
 *   labels, `multiSelect`, free-text `Other` supplied by the client).
 * - Codex `request_user_input` (stable `id`, 12-char `header`, 2-3 options,
 *   recommended option first, client-added `Other`).
 *
 * The canonical shape is the union both sources already agree on: 1-4
 * questions, omitted options for free text or 2-4 choices, unique question texts, unique labels per
 * question, header at most 12 chars. `id` is optional on input and always
 * present after normalisation (derived from the header when absent), so a
 * caller written against either source validates here.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 12;
export const MAX_QUESTION_CHARS = 500;
export const MAX_LABEL_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_REQUESTS = 64;

export type AskUserOption = {
  readonly label: string;
  readonly description: string;
};

export type AskUserQuestionInput = {
  readonly id?: string;
  readonly header: string;
  readonly question: string;
  readonly options?: ReadonlyArray<AskUserOption>;
  readonly multiSelect?: boolean;
};

export type AskUserQuestion = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<AskUserOption>;
  readonly multiSelect: boolean;
};

export type AskRequestStatus =
  | "pending"
  | "answered"
  | "cancelled"
  | "expired";

export type AskUserRequest = {
  readonly requestId: string;
  readonly questions: ReadonlyArray<AskUserQuestion>;
  readonly status: AskRequestStatus;
  readonly answers?: Readonly<Record<string, string>>;
};

export type AskValidation =
  | { readonly ok: true; readonly questions: ReadonlyArray<AskUserQuestion> }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function slugify(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const slug = lowered.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : "question";
}

function validateOption(entry: unknown): { readonly ok: true; readonly option: AskUserOption } | { readonly ok: false; readonly message: string } {
  if (isRecord(entry) === false) {
    return { ok: false, message: "every option must be an object with label and description" };
  }

  const label = entry["label"];
  const description = entry["description"];

  if (typeof label !== "string" || label.trim().length === 0) {
    return { ok: false, message: "every option needs a non-empty label" };
  }

  if (label.length > MAX_LABEL_CHARS) {
    return { ok: false, message: `option label is ${label.length} characters; the limit is ${MAX_LABEL_CHARS}` };
  }

  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, message: `option "${label}" needs a non-empty description` };
  }

  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, message: `option "${label}" description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}` };
  }

  return { ok: true, option: { label, description } };
}

function validateQuestion(entry: unknown, seenQuestions: Set<string>, seenIds: Set<string>): { readonly ok: true; readonly question: AskUserQuestion } | { readonly ok: false; readonly message: string } {
  if (isRecord(entry) === false) {
    return { ok: false, message: "every question must be an object with header, question and options" };
  }

  const header = entry["header"];
  const questionText = entry["question"];
  const rawOptions = entry["options"];
  const rawId = entry["id"];
  const rawMulti = entry["multiSelect"];

  if (typeof header !== "string" || header.trim().length === 0) {
    return { ok: false, message: "every question needs a non-empty header" };
  }

  if (header.length > MAX_HEADER_CHARS) {
    return { ok: false, message: `header "${header}" is ${header.length} characters; the limit is ${MAX_HEADER_CHARS}` };
  }

  if (typeof questionText !== "string" || questionText.trim().length === 0) {
    return { ok: false, message: "every question needs a non-empty question string" };
  }

  if (questionText.length > MAX_QUESTION_CHARS) {
    return { ok: false, message: `question is ${questionText.length} characters; the limit is ${MAX_QUESTION_CHARS}` };
  }

  if (seenQuestions.has(questionText)) {
    return { ok: false, message: `duplicate question text: "${questionText}"` };
  }

  if (rawOptions !== undefined && Array.isArray(rawOptions) === false) {
    return { ok: false, message: `question "${questionText}" needs an options array` };
  }

  const options: ReadonlyArray<unknown> = rawOptions === undefined ? [] : rawOptions as ReadonlyArray<unknown>;
    if ((options.length > 0 && options.length < MIN_OPTIONS) || options.length > MAX_OPTIONS) {
    return { ok: false, message: `question "${questionText}" needs ${MIN_OPTIONS}-${MAX_OPTIONS} options; got ${options.length}` };
  }

  const parsedOptions: AskUserOption[] = [];
  const seenLabels = new Set<string>();

  for (const raw of options) {
    const parsed = validateOption(raw);
    if (parsed.ok === false) {
      return parsed;
    }

    if (seenLabels.has(parsed.option.label)) {
      return { ok: false, message: `duplicate option label "${parsed.option.label}" in question "${questionText}"` };
    }

    seenLabels.add(parsed.option.label);
    parsedOptions.push(parsed.option);
  }

  const derivedId = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : slugify(header);
  if (seenIds.has(derivedId)) {
    return { ok: false, message: `duplicate question id: "${derivedId}"` };
  }

  if (rawMulti !== undefined && typeof rawMulti !== "boolean") {
    return { ok: false, message: `question "${questionText}" multiSelect must be a boolean when present` };
  }

  seenQuestions.add(questionText);
  seenIds.add(derivedId);

  return {
    ok: true,
    question: {
      id: derivedId,
      header,
      question: questionText,
      options: parsedOptions,
      multiSelect: rawMulti ?? false,
    },
  };
}

/**
 * Validate one `ask_user_question` argument object.
 *
 * Validation runs before any state is touched: a refused call leaves every
 * pending request whole, because half a new question over half an old inbox
 * is how a run starts answering the wrong turn.
 */
export function validateAskUserInput(argumentsValue: JsonObject): AskValidation {
  const raw = argumentsValue["questions"];
  if (Array.isArray(raw) === false) {
    return { ok: false, message: "questions must be an array of 1-4 questions" };
  }

  if (raw.length < 1 || raw.length > MAX_QUESTIONS) {
    return { ok: false, message: `questions holds ${raw.length} items; the limit is 1-${MAX_QUESTIONS}` };
  }

  const seenQuestions = new Set<string>();
  const seenIds = new Set<string>();
  const questions: AskUserQuestion[] = [];

  for (const entry of raw) {
    const parsed = validateQuestion(entry, seenQuestions, seenIds);
    if (parsed.ok === false) {
      return parsed;
    }
    questions.push(parsed.question);
  }

  return { ok: true, questions };
}

export type AnswerAdmission =
  | { readonly kind: "accepted"; readonly request: AskUserRequest }
  | { readonly kind: "rejected"; readonly reason: "unknown_request" | "already_settled" | "unknown_question" | "invalid_answer"; readonly message: string };

function splitSelections(raw: string): ReadonlyArray<string> {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Admit one answer map for a pending request.
 *
 * Late and duplicate answers are rejected, never merged: a request that has
 * already left `pending` has no address to deliver to, and silently folding a
 * second answer into the first would let a stale turn rewrite a live one.
 * Free text is legal (the client's `Other`), but an answer naming no known
 * option and carrying no text is not an answer.
 */
export function admitAnswer(
  requests: ReadonlyMap<string, AskUserRequest>,
  requestId: string,
  answers: Readonly<Record<string, string>>,
): AnswerAdmission {
  const existing = requests.get(requestId);
  if (existing === undefined) {
    return { kind: "rejected", reason: "unknown_request", message: `unknown requestId: ${requestId}` };
  }

  if (existing.status !== "pending") {
    return { kind: "rejected", reason: "already_settled", message: `request ${requestId} is already ${existing.status}; late answers are rejected` };
  }

  const byId = new Map(existing.questions.map((item) => [item.id, item]));
  const byText = new Map(existing.questions.map((item) => [item.question, item]));
  const normalised: Record<string, string> = Object.create(null);

  for (const [key, value] of Object.entries(answers)) {
    const target = byId.get(key) ?? byText.get(key);
    if (target === undefined) {
      return { kind: "rejected", reason: "unknown_question", message: `answer names unknown question: "${key}"` };
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      return { kind: "rejected", reason: "invalid_answer", message: `answer for "${target.question}" must be a non-empty string` };
    }

    const selections = target.multiSelect ? splitSelections(value) : [value.trim()];
    if (target.multiSelect && selections.length === 0) {
      return { kind: "rejected", reason: "invalid_answer", message: `answer for "${target.question}" must name at least one option` };
    }

    const labels = new Set(target.options.map((option) => option.label));
    const known = selections.filter((part) => labels.has(part));
    const freeText = selections.filter((part) => labels.has(part) === false).join(", ").trim();
    if (known.length === 0 && freeText.length === 0) {
      return { kind: "rejected", reason: "invalid_answer", message: `answer for "${target.question}" names no known option and carries no text` };
    }

    normalised[target.id] = value;
  }

  if (Object.keys(normalised).length === 0) {
    return { kind: "rejected", reason: "invalid_answer", message: "answers must cover at least one asked question" };
  }

  return {
    kind: "accepted",
    request: { ...existing, status: "answered", answers: { ...normalised } },
  };
}

/**
 * Render one answered request the way the transcript reader needs it: which
 * question got which answer, in ask order. The text is evidence, not a grant:
 * callers must never treat it as permission for a side effect.
 */
export function renderAnswers(request: AskUserRequest): string {
  const answers = request.answers ?? {};
  const lines = request.questions.map((item) => {
    const answer = answers[item.id] ?? "(no answer)";
    return `- ${item.question} -> ${answer}`;
  });
  return `User answered ${request.questions.length} question(s):\n${lines.join("\n")}`;
}
