import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Reading a project's own engineering instructions.
 *
 * A repository that states its build command, its conventions and its untouchable
 * files has written them down; a coding agent that does not read that file makes
 * the user say it again in every session. This module is the one place that
 * turns those files into messages, and it is deliberately an *adapter*: it is the
 * only code here that knows `AGENTS.md` exists, that touches the disk, or that
 * hashes anything. The loop receives finished messages and stays ignorant of all
 * three (WP-CLI-B1 §3.2).
 *
 * What this is not: it is not a learning asset, not a Profile rule, and not a
 * Board product. `contract/context.ts::composeMessages` labels Profile content as
 * learned historical hints, and an engineering rule wearing that label would be
 * a lie about where it came from — and would change meaning the moment someone
 * turned the learning switch off. These messages are assembled by the CLI host
 * and enter the request through the generic caller-messages seam, so they are
 * present whether or not any learning subsystem exists.
 */

/**
 * One candidate per directory, in precedence order.
 *
 * The first hit wins and the rest are not read. Three same-purpose files in one
 * directory are not three rule sets to be merged and averaged — they are three
 * attempts to state the same thing, and stacking them produces a project whose
 * instructions contradict each other with nothing to say which wins.
 */
export const PROJECT_INSTRUCTION_FILENAMES: ReadonlyArray<string> = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

/** Where a rule came from, recorded so a user can audit what was adopted. */
export type InstructionSource = "project_file";

/** Which part of the tree a rule governs. */
export type InstructionScope = "workspace_root" | "directory";

export type ProjectInstruction = {
  /** Workspace-relative, forward-slashed; the identity a user can check. */
  readonly relativePath: string;
  readonly absolutePath: string;
  /** The directory whose subtree this rule governs. */
  readonly scope: InstructionScope;
  /** The directory scope applies to, workspace-relative (`.` for the root). */
  readonly scopePath: string;
  readonly text: string;
  /** Content hash, so a resume can say the rule changed without re-reading prose. */
  readonly contentHash: string;
  readonly source: InstructionSource;
  /**
   * True when the file was read but its text hit the ceiling. A truncated rule
   * set that reported itself as complete would be a lie the model cannot detect.
   */
  readonly truncated: boolean;
};

/** One directory's rule file, plus why it is absent when it is. */
export type InstructionLookup =
  | { readonly kind: "found"; readonly instruction: ProjectInstruction }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly relativePath: string; readonly detail: string }
  | { readonly kind: "oversized"; readonly relativePath: string; readonly bytes: number };

export type InstructionReader = {
  /** Returns the file's text, or undefined when the path is not a readable file. */
  readText(absolutePath: string): string | undefined;
  fileSize(absolutePath: string): number | undefined;
};

/**
 * The ceiling on one rule file.
 *
 * Not a cap on total instructions — it is the point where a file has stopped
 * being engineering rules and become a document the agent should be *asked* to
 * read, not have pasted into every request. Above it the file is reported as
 * oversized rather than silently shortened, because half a rule set is a rule
 * set with the important half missing.
 */
export const MAX_INSTRUCTION_BYTES = 64 * 1024;

export function createNodeInstructionReader(): InstructionReader {
  return {
    readText(absolutePath) {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        // An existing unreadable file is diagnosed by lookupInstruction using its stat.
        return undefined;
      }
    },
    fileSize(absolutePath) {
      try {
        const stat = statSync(absolutePath);
        return stat.isFile() ? stat.size : undefined;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}

export function hashInstruction(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Forward-slashed, workspace-relative form of an absolute path. */
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  return relative.length === 0 ? "." : relative;
}

/**
 * The rule file for one directory, or the reason there is none.
 *
 * `scopePath` is the workspace-relative directory the rule governs, which is the
 * answer to "what does this rule apply to" — a rule is only ever meaningful
 * together with the subtree it was found in.
 */
export function lookupInstruction(
  reader: InstructionReader,
  workspaceRoot: string,
  directoryAbsolute: string,
  scope: InstructionScope,
): InstructionLookup {
  for (const name of PROJECT_INSTRUCTION_FILENAMES) {
    const absolutePath = path.join(directoryAbsolute, name);
    const size = reader.fileSize(absolutePath);
    if (size === undefined) {
      continue;
    }

    const relativePath = toWorkspaceRelative(workspaceRoot, absolutePath);

    if (size > MAX_INSTRUCTION_BYTES) {
      return { kind: "oversized", relativePath, bytes: size };
    }

    const text = reader.readText(absolutePath);
    if (text === undefined) {
      return { kind: "unreadable", relativePath, detail: "read_failed" };
    }

    return {
      kind: "found",
      instruction: {
        relativePath,
        absolutePath,
        scope,
        scopePath: toWorkspaceRelative(workspaceRoot, directoryAbsolute),
        text,
        contentHash: hashInstruction(text),
        source: "project_file",
        truncated: false,
      },
    };
  }
  return { kind: "absent" };
}

/**
 * The ancestor chain from the workspace root down to `directoryAbsolute`, root
 * first.
 *
 * Root-to-leaf order is the order the rules compose in: a deeper rule refines
 * the one above it, and a reader can see that by reading down the list. Bounded
 * by the workspace root on purpose — walking past it would read a parent
 * project's rules for a subdirectory run, which is a different project (WP §3.1).
 */
export function ancestorChain(
  workspaceRoot: string,
  directoryAbsolute: string,
): ReadonlyArray<string> {
  const canonicalRoot = path.resolve(workspaceRoot);
  const chain: string[] = [];
  let current = path.resolve(directoryAbsolute);

  for (;;) {
    chain.push(current);

    if (current === canonicalRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Not under the root after all; the root is the boundary either way.
      break;
    }

    current = parent;
  }

  return chain.reverse();
}
