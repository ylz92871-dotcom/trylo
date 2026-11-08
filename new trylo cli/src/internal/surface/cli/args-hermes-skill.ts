import { isSkillIssueReference, isSkillNativeMethod, type HermesSkillGrant, type SkillNativeMethod } from "../../learning/agent/subsystems/skill/index.js";
import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";

export type HermesSkillControlOptions = { readonly subsystem: "skill"; readonly control: "issues" | "dispatch";
  readonly workspace?: string; readonly issueId?: string } | { readonly subsystem: "skill"; readonly control: "focus"; readonly workspace?: string };

export type HermesSkillNativeOptions = { readonly subsystem: "skill"; readonly nativeMethod: SkillNativeMethod };

export type HermesSkillExplicitOptions = { readonly subsystem: "skill"; readonly explicit: true };

export type HermesSkillLearnOptions = { readonly subsystem: "skill"; readonly grant: HermesSkillGrant } | HermesSkillControlOptions | HermesSkillNativeOptions | HermesSkillExplicitOptions;

const HINT = "try `trylo learn skill --tokens N --calls N`; --tokens is the output-token allowance";
const CONTROL_HINT = "try `trylo learn skill issues --json`, `trylo learn skill focus -`, or `trylo learn skill dispatch [--issue ID]`; focus reads an explicit total_model_tokens v2 allowance from stdin";

/** Only allocation crosses this boundary; native Hermes owns what to learn. */
export function parseHermesSkillLearn(argv: readonly string[]): ParsedCommand {
  if (argv[0] === "native") return argv.length === 3 && isSkillNativeMethod(argv[1]) && argv[2] === "-"
    ? { kind: "learn", options: { subsystem: "skill", nativeMethod: argv[1] } }
    : usageError("native skill administration requires an allowed method and JSON stdin '-'", "try `trylo learn skill native skillsQuery -`");

  if (argv[0] === "explicit") return argv.length === 2 && argv[1] === "-"
    ? { kind: "learn", options: { subsystem: "skill", explicit: true } }
    : usageError("explicit skill learning requires a canonical source and output allowance from JSON stdin", "try `trylo learn skill explicit -`");

  if (argv[0] === "issues" || argv[0] === "focus" || argv[0] === "dispatch") return parseControl(argv);

  const values = new Map<string, number>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], raw = argv[index + 1];
    if ((flag !== "--tokens" && flag !== "--calls") || values.has(flag) || raw === undefined
      || !/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return usageError("skill learning accepts unique nonnegative integer --tokens and --calls only", HINT);
    }
    values.set(flag, Number(raw));
  }

  const maxOutputTokens = values.get("--tokens"), maxCalls = values.get("--calls");
  if (maxOutputTokens === undefined || maxCalls === undefined) return usageError("skill learning requires explicit --tokens and --calls", HINT);

  return { kind: "learn", options: { subsystem: "skill", grant: { subsystem: "skill", allowance: { maxCalls, maxOutputTokens } } } };
}

function parseControl(argv: readonly string[]): ParsedCommand {
  const control = argv[0];
  if (control !== "issues" && control !== "focus" && control !== "dispatch") return usageError("invalid skill control command", CONTROL_HINT);

  let workspace: string | undefined, issueId: string | undefined, json = false, stdin = false;

  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json" && !json && control === "issues") {
      json = true;
      continue;
    }

    if (arg === "-" && !stdin && control === "focus") {
      stdin = true;
      continue;
    }

    if (arg === "--workspace" && workspace === undefined) {
      const next = argv[++index];
      if (next !== undefined && next.trim() && next.length <= 4096 && !next.startsWith("--") && !/[\u0000-\u001f]/u.test(next)) {
        workspace = next;
        continue;
      }
    } else if (arg === "--issue" && issueId === undefined && control !== "focus") {
      const next = argv[++index];
      if (isSkillIssueReference(next) && !next.startsWith("--")) {
        issueId = next;
        continue;
      }
    }

    return usageError("invalid or duplicate skill control option", CONTROL_HINT);
  }

  if (control === "focus" && !stdin) return usageError("skill focus requires JSON from stdin using '-'", CONTROL_HINT);

  const common = { subsystem: "skill" as const, ...(workspace === undefined ? {} : { workspace }) };

  if (control === "focus") return { kind: "learn", options: { ...common, control } };

  return { kind: "learn", options: { ...common, control, ...(issueId === undefined ? {} : { issueId }) } };
}
