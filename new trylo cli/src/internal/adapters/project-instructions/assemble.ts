import path from "node:path";
import type { Message } from "../../contract/execution.js";
import {
  ancestorChain,
  hashInstruction,
  lookupInstruction,
  type InstructionLookup,
  type InstructionReader,
  type ProjectInstruction,
} from "./instruction-reader.js";
import { expandInstructionImports } from "./imports.js";

/** The environment facts a run can state without guessing. */
export type EnvironmentFacts = {
  readonly platform?: string | undefined;
  readonly nodeVersion: string;
  /** The workspace root the tools are actually confined to. */
  readonly workspaceRoot: string;
  /** The directory the process started in, when it differs from the root. */
  readonly startupDirectory?: string | undefined;
};

export type AssembledInstructions = {
  readonly messages: ReadonlyArray<Message>;
  /** What was adopted, for the run's own diagnostics and session record. */
  readonly adopted: ReadonlyArray<ProjectInstruction>;
  /** Files that exist but could not be used, each with its reason. */
  readonly problems: ReadonlyArray<string>;
};

/**
 * One `system` message per adopted rule file, plus one environment message.
 *
 * Separate messages rather than one concatenated blob: the model can then be
 * told which rule came from which file, and a user comparing the request against
 * the repository can find the same text in the same place.
 */
export function assembleInstructionMessages(
  adopted: ReadonlyArray<ProjectInstruction>,
  environment: EnvironmentFacts,
): ReadonlyArray<Message> {
  const messages: Message[] = [];

  messages.push(environmentMessage(environment));

  for (const instruction of adopted) {
    messages.push({
      role: "system",
      content: [
        `Project instructions from ${instruction.relativePath} (${scopeWording(instruction)}).`,
        "These are this project's own engineering rules, read from the file named above.",
        "They are not learned suggestions and they were not produced by an earlier session.",
        "Follow them for work in this project, and prefer the project's stated commands over guesses.",
        "If the user's current instruction conflicts with one of them, say so and follow the user.",
        "",
        instruction.text,
      ].join("\n"),
    });
  }

  return messages;
}

function scopeWording(instruction: ProjectInstruction): string {
  return instruction.scope === "workspace_root"
    ? "applies to the whole workspace"
    : `applies to ${instruction.scopePath}/ and below`;
}

function environmentMessage(environment: EnvironmentFacts): Message {
  const lines = [
    "Environment for this run:",
    `- platform: ${environment.platform ?? "not reported by this build"}`,
    `- node: ${environment.nodeVersion}`,
    `- workspace root: ${environment.workspaceRoot}`,
  ];

  if (environment.startupDirectory !== undefined) {
    lines.push(`- started in: ${environment.startupDirectory}`);
  }

  lines.push(
    "Tool paths are relative to the workspace root. For shell commands follow the mounted tool's description and argument schema: the configured shell accepts full command strings, while direct execution accepts only planner-approved pipelines and sequential commands. Use syntax for the actual interpreter on this platform. Read a target before editing so its local project rules are discovered.",
    "For multi-step or lengthy tool work, send a brief user-facing progress update before starting and when your plan or results materially change. State what you are checking, the useful result, and the next step; do not expose private chain-of-thought. Skip progress narration for simple answers or when the user asks for results only. Finish with the outcome, checks actually performed, and any unresolved limitation; every success claim must have evidence.",
    "For existing source files prefer edit_file: it preserves untouched bytes and original line endings. write_file replaces the entire file with the supplied bytes; if you use it, retain the project's line-ending convention yourself. Do not report a project convention as preserved without checking the resulting file.",
    "edit_file.patch expects raw unified diff, without Markdown fences: every unchanged/context line starts with ONE diff-space followed by the full original line, including its indentation. A source line ' * doc' must be written as '  * doc' in context. Removed/added lines start with -/+ followed by the full original line. Use @@ alone when you have not counted hunk lines.",
  );

  return { role: "system", content: lines.join("\n") };
}

/**
 * Reads the rules that apply to a turn and returns them as messages.
 *
 * The chain is workspace root first, then the ancestors of `startupDirectory`
 * down to it, so running from a subdirectory still sees the project's root
 * rules. The same file is never assembled twice — the root appears once in the
 * chain and `readFile` is called at most once per directory.
 */
export function loadInstructionMessages(input: {
  readonly reader: InstructionReader;
  readonly workspaceRoot: string;
  readonly startupDirectory: string;
  readonly environment: EnvironmentFacts;
}): AssembledInstructions {
  const adopted: ProjectInstruction[] = [];
  const problems: string[] = [];
  const chain = ancestorChain(input.workspaceRoot, input.startupDirectory);
  const seen = new Set<string>();

  chain.forEach((directory, index) => {
    const scope = index === 0 ? "workspace_root" : "directory";
    const lookup = lookupInstruction(input.reader, input.workspaceRoot, directory, scope);
    // A rule is a property of a file, not of a directory: the same file reached
    // through two paths is one rule, not two agreeing ones.
    const identity = lookup.kind === "found" ? lookup.instruction.absolutePath : directory;
    if (seen.has(identity)) {
      return;
    }

    seen.add(identity);

    if (lookup.kind === "found") {
      adopted.push(adoptWithImports(lookup.instruction, input, (problem) => problems.push(problem)));
      return;
    }

    if (lookup.kind === "oversized") {
      problems.push(`project_instructions_oversized:${lookup.relativePath}`);
      return;
    }

    if (lookup.kind === "unreadable") {
      problems.push(`project_instructions_unreadable:${lookup.relativePath}`);
    }
  });

  return {
    messages: assembleInstructionMessages(adopted, input.environment),
    adopted,
    problems,
  };
}

/**
 * Expands a rule's whole-line `@imports` before its text enters the request
 * (L50). The adopted instruction's text and hash describe what the model will
 * actually see, so an expanded rule re-hashes its expanded text; import
 * problems join the assembly's problems under the rule's own name.
 */
function adoptWithImports(
  instruction: ProjectInstruction,
  input: {
    readonly reader: InstructionReader;
    readonly workspaceRoot: string;
  },
  onProblem: (problem: string) => void,
): ProjectInstruction {
  const expansion = expandInstructionImports({
    text: instruction.text,
    baseDirectory: path.dirname(instruction.absolutePath),
    workspaceRoot: input.workspaceRoot,
    reader: input.reader,
  });

  for (const problem of expansion.problems) {
    onProblem(`${problem}@${instruction.relativePath}`);
  }

  if (expansion.text === instruction.text) {
    return instruction;
  }

  return {
    ...instruction,
    text: expansion.text,
    contentHash: hashInstruction(expansion.text),
  };
}

export function lookupLocalInstructions(
  reader: InstructionReader,
  workspaceRoot: string,
  targetAbsolute: string,
): ReadonlyArray<ProjectInstruction> {
  const directory = path.dirname(targetAbsolute);
  const chain = ancestorChain(workspaceRoot, directory);
  const found: ProjectInstruction[] = [];

  chain.forEach((entry, index) => {
    const lookup: InstructionLookup = lookupInstruction(
      reader,
      workspaceRoot,
      entry,
      index === 0 ? "workspace_root" : "directory",
    );
    if (lookup.kind === "found") {
      found.push(lookup.instruction);
    }
  });

  return found;
}
