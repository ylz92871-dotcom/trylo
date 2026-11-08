import { flagToken, readLearning, usageError } from "./args-tokens.js";
import type { LearningSwitch, ParsedCommand } from "./args-primitives.js";

/**
 * `doctor` argument parsing.
 *
 * A family parser like `args-mcp.ts` / `args-session.ts`, living here for the
 * same reason they do: the shared vocabulary file is shapes and closed sets only,
 * and a parser that grows a family's own quirks does not belong in it.
 *
 * It stays apart from `parseSimple` on purpose. `config show` and `session list`
 * must not start accepting a `--learning` they do not consume just because the
 * switch exists — taking a flag and ignoring it makes a mistyped flag look
 * accepted.
 */

export function parseDoctor(
  argv: ReadonlyArray<string>,
  seed?: LearningSwitch,
): ParsedCommand {
  let json = false;
  let learning = seed;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    const parsed = token.startsWith("--") ? flagToken(token) : undefined;
    if (parsed === undefined || parsed.name !== "learning") {
      return usageError(
        `doctor does not accept ${token}`,
        "run `trylo doctor --help` for accepted options",
      );
    }

    const got = readLearning(argv, index, parsed.inlineValue);
    if (got.error !== undefined) {
      return got.error;
    }

    learning = got.value;
    index = got.next - 1;
  }

  return { kind: "doctor", json, ...(learning === undefined ? {} : { learning }) };
}
