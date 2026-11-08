import {
  isLearningSwitch,
  LEARNING_SWITCH_VALUES,
  type LearningSwitch,
} from "../../integration/user-learning/switch.js";
import type { ParsedCommand } from "./args-primitives.js";

/**
 * Token-level parsing primitives shared by every command family.
 *
 * Moved out of `args-primitives.ts` so the vocabulary file (closed sets,
 * option shapes, the `ParsedCommand` union) stays under the package file
 * limit. This module is the single authority for reading argv tokens; the
 * families import from here, never from each other. The `ParsedCommand`
 * import is type-only, so there is no runtime cycle back to the vocabulary.
 */

export function usageError(message: string, hint: string): ParsedCommand {
  return { kind: "error", message, hint };
}

export type FlagSpec = {
  readonly name: string;
  readonly takesValue: boolean;
};

export function flagSpecFor(flags: ReadonlyArray<FlagSpec>, name: string): FlagSpec | undefined {
  return flags.find((flag) => flag.name === name);
}

/** Reads `--flag value` and `--flag=value` uniformly. */
export function readValue(
  argv: ReadonlyArray<string>,
  index: number,
  inlineValue: string | undefined,
): { readonly value?: string; readonly next: number; readonly error?: string } {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      return { next: index + 1, error: "empty value" };
    }
    return { value: inlineValue, next: index + 1 };
  }

  const next = argv[index + 1];
  if (next === undefined) {
    return { next: index + 1, error: "missing value" };
  }

  return { value: next, next: index + 2 };
}

/**
 * 读并校验一次 `--learning` 的出现。
 *
 * 三处收旗（全局前导、run 家族、doctor）都走这里，所以「值不合法 = 用法错」
 * 这条规则只有一个实现——宽容一个拼错的值会让它**静默**变成另一种行为，而开关
 * 的全部意义是「我明确要它」。`error` 存在时 `value` 无意义。
 */
export function readLearning(
  argv: ReadonlyArray<string>,
  index: number,
  inlineValue: string | undefined,
): { readonly value?: LearningSwitch; readonly next: number; readonly error?: ParsedCommand } {
  const read = readValue(argv, index, inlineValue);
  if (read.error !== undefined) {
    return {
      next: read.next,
      error: usageError(
        `option --learning ${read.error}`,
        `pass --learning=<${LEARNING_SWITCH_VALUES}>`,
      ),
    };
  }

  const value = read.value ?? "";
  if (!isLearningSwitch(value)) {
    return {
      next: read.next,
      error: usageError(
        `unknown learning switch: ${value}`,
        `accepted values are --learning=<${LEARNING_SWITCH_VALUES}>`,
      ),
    };
  }

  return { value, next: read.next };
}

export function parsePositiveInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : undefined;
}

/** Splits `--name` / `--name=value` into its parts; `undefined` when not a flag. */
export function flagToken(token: string): { readonly name: string; readonly inlineValue: string | undefined } | undefined {
  if (!token.startsWith("--")) {
    return undefined;
  }

  const withoutPrefix = token.slice(2);
  const equalsAt = withoutPrefix.indexOf("=");
  if (equalsAt < 0) {
    return { name: withoutPrefix, inlineValue: undefined };
  }

  return { name: withoutPrefix.slice(0, equalsAt), inlineValue: withoutPrefix.slice(equalsAt + 1) };
}

const BOOLEAN_ONLY = new Set(["--json", "--help", "-h", "--version", "-v"]);

/** Parser for the `--json`-only diagnostic commands (doctor, config show, …). */
export function parseSimple(
  argv: ReadonlyArray<string>,
  make: (json: boolean) => ParsedCommand,
  name: string,
): ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (!BOOLEAN_ONLY.has(token)) {
      return usageError(
        `${name} does not accept ${token}`,
        `run \`trylo ${name} --help\` for accepted options`,
      );
    }
  }

  return make(json);
}
