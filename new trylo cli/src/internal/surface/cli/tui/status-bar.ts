import { displayWidth } from "./frame.js";
import type { TuiState } from "./state.js";
import type { WaitingReason } from "./waiting.js";
import { fitText, projectName } from "./text.js";

/**
 * The status bar: one deterministic line over the frame state, fitted to the
 * width it has.
 *
 * Everything it shows is either a session fact (session id, provider, model,
 * iteration ceiling), something a surface event said (the running flag, the
 * last `run_result`'s iteration count, status, token counts and duration), or
 * a tool call opened and not yet closed. Nothing is extrapolated: while a turn
 * runs without a new event, the bar keeps the last known facts.
 *
 * The fit is a priority order, not a truncation. Until this changed the bar was
 * assembled left to right and then cut, which meant the only thing a narrow
 * terminal was guaranteed to keep was the session id — the least useful field
 * on it — while the iteration budget and the token count were silently amputated
 * at the right-hand end. Now every field declares how much it matters, and the
 * ones that do not fit are the ones that do not fit *by choice*: `phase` and
 * the current model take priority over iteration and token diagnostics.
 */

/** Where a field sits in the rendered line, left to right. */
type FieldOrder = number;

/** How much a field matters; higher survives a narrower terminal. */
type FieldPriority = number;

type Field = {
  readonly order: FieldOrder;
  readonly priority: FieldPriority;
  readonly text: string;
};

/**
 * The spinner: proof the turn is still alive.
 *
 * A long turn draws the same frame for thirty seconds, and a screen that does
 * not change reads as a hung process — which is why people press Ctrl-C on
 * turns that were never stuck. The glyph is chosen by the caller's tick, so
 * this stays a pure function of the frame state, and the frame renderer stays
 * testable without a clock.
 *
 * Braille rather than ASCII (`|/-\`): one column, and it animates by itself
 * without the eye tracking a character that jumps position.
 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerOf(tick: number): string {
  return SPINNER[tick % SPINNER.length] ?? SPINNER[0] ?? "";
}

export function statusBar(state: TuiState, columns: number, tick = 0): string {
  const context = contextText(state);
  const fields: ReadonlyArray<Field> = [
    ...(columns < 140 ? [] : [{ order: 0, priority: 0, text: `session ${state.facts.sessionId}` }]),
    { order: 1, priority: 4, text: fitText(`${state.facts.providerId}/${state.facts.model}`, Math.max(12, Math.floor(columns * 0.5))) },
    { order: 2, priority: 0, text: `iter ${iterationText(state)}` },
    ...(state.toolsInFlight.size === 0 ? [] : [{ order: 3, priority: 2, text: `tools ${toolsText(state)}` }]),
    ...(state.usage === undefined ? [] : [{ order: 4, priority: 1, text: usageText(state) }]),
    ...(state.durationMs === undefined ? [] : [{ order: 5, priority: 2, text: durationText(state) }]),
    { order: 6, priority: 5, text: phaseText(state, tick) },
    ...((state.pendingInputCount ?? 0) === 0 ? [] : [{ order: 10, priority: 4, text: `排队 ${state.pendingInputCount}` }]),
    ...(context === undefined ? [] : [{ order: 7, priority: 2, text: context }]),
    ...(state.facts.workspaceRoot === undefined ? [] : [{ order: 8, priority: 3, text: projectName(state.facts.workspaceRoot) }]),
    ...(state.facts.permissionMode === undefined ? [] : [{ order: 9, priority: 3, text: state.facts.permissionMode }]),
  ];

  return fit(fields, columns);
}

/**
 * Keep as many fields as the width allows, dropping the least important first,
 * then render what survived in reading order.
 *
 * A field that cannot fit even alone is kept anyway rather than dropped, so a
 * five-column terminal still shows something: a bar that renders empty because
 * everything was too long is strictly worse than one that overflows.
 */
function fit(fields: ReadonlyArray<Field>, columns: number): string {
  const kept: Field[] = [];
  let width = 0;

  for (const field of [...fields].sort((a, b) => b.priority - a.priority)) {
    const own = displayWidth(field.text);
    const grown = kept.length === 0 ? own : width + displayWidth(SEPARATOR) + own;
    if (kept.length > 0 && grown > columns) {
      continue;
    }

    kept.push(field);
    width = grown;
  }

  return kept
    .sort((a, b) => a.order - b.order)
    .map((field) => field.text)
    .join(SEPARATOR);
}

const SEPARATOR = " | ";

function iterationText(state: TuiState): string {
  const done = state.iterations === undefined ? "-" : String(state.iterations);
  const max = state.facts.maxIterations === undefined ? "-" : String(state.facts.maxIterations);
  return `${done}/${max}`;
}

function toolsText(state: TuiState): string {
  if (state.toolsInFlight.size === 0) {
    return "-";
  }
  return [...state.toolsInFlight.values()].map(tool => tool.name).join(",");
}

/**
 * Thousands are shortened because the bar is one line and a token count is
 * read for magnitude, not for bookkeeping: `18.4k` is the fact, `18422` is the
 * same fact wearing a costume.
 */
function usageText(state: TuiState): string {
  const usage = state.usage;
  if (usage === undefined) {
    return "";
  }
  return `tok ${compact(usage.inputTokens)}/${compact(usage.outputTokens)}`;
}

function compact(count: number): string {
  if (count < 1000) {
    return String(count);
  }

  // One decimal while it still says something: 18.4k distinguishes two turns
  // that 18k does not, and a bar that only ever reports the same number is a
  // bar nobody reads. Past a hundred thousand the decimal is noise.
  if (count < 100_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }

  return `${Math.round(count / 1000)}k`;
}

function durationText(state: TuiState): string {
  const ms = state.durationMs;
  if (ms === undefined) {
    return "";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

function phaseText(state: TuiState, tick: number): string {
  const waiting = waitingText(state.waiting);

  if (state.running) {
    return waiting === undefined
      ? `${spinnerOf(tick)} running`
      : `${spinnerOf(tick)} running · waiting on ${waiting}`;
  }

  return waiting === undefined
    ? state.lastStatus === undefined
      ? "idle"
      : `last ${state.lastStatus}`
    : `waiting on ${waiting}`;
}

/**
 * The wait reason, in the words a person can act on (WP23.3).
 *
 * The bar is one line, so each reason says the *kind* of waiting and the thing
 * waited on; the panel the events drew says the rest. A question names its
 * request id because that is what the model's `answer_user_question` call is
 * keyed on — the same handle the panel showed.
 */
function waitingText(waiting: WaitingReason | undefined): string | undefined {
  if (waiting === undefined) {
    return undefined;
  }

  if (waiting.kind === "tool") {
    return `tool ${waiting.names.join(",")}`;
  }

  if (waiting.kind === "question") {
    return `your answer${waiting.requestId === undefined ? "" : ` (${waiting.requestId})`}`;
  }

  return "your approval (plan)";
}

/**
 * How much of the context window this turn has filled.
 *
 * Input tokens stand in for context size, which is the same approximation
 * every mature CLI makes. Shown only when the run actually resolved a ceiling:
 * a percentage against a guessed denominator is worse than no percentage.
 * Priority 3 — it survives a narrow terminal, because "you are about to run
 * out of room" is exactly the field a narrow terminal must not drop.
 */
function contextText(state: TuiState): string | undefined {
  const limit = state.facts.contextTokenLimit;
  if (limit === undefined || limit <= 0 || state.usage === undefined) {
    return undefined;
  }
  const percent = Math.round((state.usage.inputTokens / limit) * 100);
  return `ctx ${Math.min(percent, 100)}%`;
}
