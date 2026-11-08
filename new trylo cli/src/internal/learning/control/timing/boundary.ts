/** Pure analysis failures; no failure grants execution authority or implies wait. */
export type TimingFailure = {
  readonly status: "invalid_input" | "unsupported_model" | "binding_mismatch" | "planning_limit" | "numeric_limit";
  readonly reason: string;
  readonly at: string;
};

export class TimingStop extends Error {
  readonly failure: TimingFailure;

  constructor(failure: TimingFailure) {
    super(failure.reason);
    this.name = "TimingStop";
    this.failure = Object.freeze({ ...failure });
  }
}

export function failTiming(status: TimingFailure["status"], reason: string, at: string): never {
  throw new TimingStop({ status, reason, at });
}

export function requireTiming(condition: unknown, reason: string, at: string): asserts condition {
  if (!condition) failTiming("invalid_input", reason, at);
}

/** Parse once. Syntax errors from evaluate remain programming errors, not bad JSON. */
export function runTimingJson<T>(json: unknown, evaluate: (raw: unknown) => T): T | TimingFailure {
  try {
    requireTiming(typeof json === "string", "json_string_required", "input");
    requireTiming(json.length <= 65536, "json_size_limit", "input");
    let raw: unknown;

    try { raw = JSON.parse(json); }
    catch (error) {
      if (error instanceof SyntaxError) failTiming("invalid_input", "invalid_json", "input");
      throw error;
    }

    return evaluate(raw);
  } catch (error) {
    if (error instanceof TimingStop) return error.failure;
    throw error;
  }
}
