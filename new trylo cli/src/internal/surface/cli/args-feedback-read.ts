import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";
import { isValidSessionId } from "./session-paths.js";

export interface FeedbackReadOptions {
  readonly subsystem: "feedback";
  readonly readOnly: true;
  readonly session: string;
  readonly delta: number;
  readonly through?: number;
}

const HINT = "try `trylo learn feedback --session ID [--through N] [--delta 0.05]`; reads one session without starting learning";

export function parseFeedbackRead(argv: readonly string[]): ParsedCommand {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, raw = argv[i + 1];
    if (!["--session", "--through", "--delta"].includes(flag) || values.has(flag) || raw === undefined) {
      return usageError("invalid or duplicate feedback read option", HINT);
    }
    values.set(flag, raw);
  }

  const session = values.get("--session"), throughText = values.get("--through"), deltaText = values.get("--delta");
  const delta = deltaText === undefined ? 0.05 : Number(deltaText);
  if (session === undefined || !isValidSessionId(session)
    || (deltaText !== undefined && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(deltaText))
    || !Number.isFinite(delta) || delta <= 0 || delta >= 1) return usageError("invalid feedback read identity or delta", HINT);

  if (throughText !== undefined && (!/^\d+$/.test(throughText) || !Number.isSafeInteger(Number(throughText)))) {
    return usageError("feedback through must be a nonnegative safe integer", HINT);
  }

  return { kind: "learn", options: { subsystem: "feedback", readOnly: true, session, delta,
    ...(throughText === undefined ? {} : { through: Number(throughText) }) } };
}
