import path from "node:path";
import {
  ancestorChain,
  createNodeInstructionReader,
  lookupInstruction,
  type InstructionLookup,
  type InstructionReader,
  type ProjectInstruction,
} from "./instruction-reader.js";
import type { LocalRuleLookup, LocalRuleNote } from "./appendix.js";

type Memo = ProjectInstruction | "absent" | "unusable";

export type LocalRuleLookupInput = {
  readonly onProblem?: (problem: string) => void;
  readonly workspaceRoot: string;
  /**
   * The reader. Required here and defaulted by `createLocalRuleLookup`, so the
   * testable variant cannot accidentally become the shipped one.
   */
  readonly reader: InstructionReader;
  /**
   * Workspace-relative paths already in this run's request, from the root
   * chain. Absent means "adopted nothing", which is the honest state of a
   * project with no rule file — every read then carries what it finds.
   */
  readonly adoptedPaths?: ReadonlyArray<string> | undefined;
};

export function createLocalRuleLookup(
  input: Omit<LocalRuleLookupInput, "reader">,
): LocalRuleLookup {
  const reader = createNodeInstructionReader();
  return buildLocalRuleLookup({ ...input, reader }, reader);
}

/**
 * The same lookup over an injected reader.
 *
 * Split from the factory above so a test can count the reads a turn actually
 * performs — the freeze is a claim about I/O, and a claim about I/O that can
 * only be checked by reading a file is not much of a claim.
 */
export function buildLocalRuleLookup(
  input: LocalRuleLookupInput,
  reader: InstructionReader,
): LocalRuleLookup {
  const adopted = new Set(input.adoptedPaths ?? []);
  const memo = new Map<string, Memo>();
  const resolve = (directory: string, scope: ProjectInstruction["scope"]): Memo => {
    const lookup: InstructionLookup = lookupInstruction(
      reader,
      input.workspaceRoot,
      directory,
      scope,
    );
    if (lookup.kind === "found") {
      return lookup.instruction;
    }

    if (lookup.kind !== "absent") input.onProblem?.(`project_instructions_${lookup.kind}:${lookup.relativePath}`);

    return lookup.kind === "absent" ? "absent" : "unusable";
  };

  return (targetAbsolutePath: string): ReadonlyArray<LocalRuleNote> => {
    // The *directory*, not the file: a rule lives in a directory, and asking
    // for `src/button.ts/AGENTS.md` would probe three filenames that can never
    // exist — once per file read, for an answer that is always "absent".
    const chain = ancestorChain(input.workspaceRoot, path.dirname(targetAbsolutePath));
    const notes: LocalRuleNote[] = [];

    chain.forEach((directory, index) => {
      const scope = index === 0 ? "workspace_root" : "directory";
      // A rule is a property of the directory's rule file, so the memo is keyed
      // by the directory rather than by the target: two files in one directory
      // must not read the same rules twice, and must not disagree about them.
      const key = `${scope}:${directory}`;
      const held = memo.get(key);
      const rule: Memo = held ?? resolve(directory, scope);

      memo.set(key, rule);

      if (rule === "absent" || rule === "unusable") {
        return;
      }

      if (adopted.has(rule.relativePath)) {
        return;
      }

      notes.push({
        relativePath: rule.relativePath,
        scopePath: rule.scopePath,
        scope: rule.scope,
        contentHash: rule.contentHash,
        text: rule.text,
      });
    });

    return notes;
  };
}
