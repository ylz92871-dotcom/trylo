import {
  createNodeInstructionReader,
  type InstructionReader,
} from "../../adapters/project-instructions/instruction-reader.js";
import type { LocalRuleLookup } from "../../adapters/project-instructions/appendix.js";
import type { SessionRecord } from "../../ports/session.js";
import path from "node:path";
import { recordedLocalSources, ruleChangeNotice, type RuleChange } from "./rule-changes.js";
import { createLocalRuleLookup } from "../../adapters/project-instructions/local-lookup.js";
import { loadInstructionMessages } from "../../adapters/project-instructions/assemble.js";
import type { CliContext } from "./context.js";
import type { ProjectContext } from "./host.js";

export function projectContextFor(
  ctx: CliContext,
  workspaceRoot: string,
  reader?: InstructionReader,
): ProjectContext | undefined {
  const assembled = loadInstructionMessages({
    reader: reader ?? createNodeInstructionReader(),
    workspaceRoot,
    startupDirectory: ctx.cwd,
    environment: {
      ...(ctx.platform === undefined ? {} : { platform: ctx.platform }),
      nodeVersion: ctx.nodeVersion,
      workspaceRoot,
      startupDirectory: ctx.cwd,
    },
  });
  return {
    messages: assembled.messages,
    sources: assembled.adopted.map((rule) => ({
      relativePath: rule.relativePath,
      scopePath: rule.scopePath,
      contentHash: rule.contentHash,
      scope: rule.scope,
    })),
    problems: assembled.problems,
  };
}

export function localRulesFor(
  workspaceRoot: string,
  projectContext: ProjectContext | undefined,
  onProblem?: (problem: string) => void,
  records?: ReadonlyArray<SessionRecord>,
): LocalRuleLookup | undefined {
  const previous = new Map(recordedLocalSources(records).map(source => [source.relativePath, source]));
  const lookup = createLocalRuleLookup({
    workspaceRoot,
    adoptedPaths: projectContext?.sources.map((source) => source.relativePath) ?? [],
    ...(onProblem === undefined ? {} : { onProblem }),
  });
  const reported = new Set<string>();

  return target => {
    const notes = lookup(target);
    const changes: RuleChange[] = [];

    for (const note of notes) {
      const before = previous.get(note.relativePath);
      if (before !== undefined && before.contentHash !== note.contentHash) {
        changes.push({ kind: "changed", relativePath: note.relativePath });
      }
    }

    const relativeTarget = path.relative(workspaceRoot, target).replaceAll("\\", "/");
    const present = new Set([...notes.map(note => note.relativePath), ...(projectContext?.sources.map(source => source.relativePath) ?? [])]);

    for (const source of previous.values()) {
      const applies = source.scopePath === "." || relativeTarget.startsWith(source.scopePath + "/");
      if (applies && !present.has(source.relativePath)) changes.push({ kind: "removed", relativePath: source.relativePath });
    }

    const unseen = changes.filter(change => !reported.has(change.relativePath));

    for (const change of unseen) reported.add(change.relativePath);

    const notice = ruleChangeNotice(unseen);
    if (notice !== undefined) onProblem?.(notice);

    return notes;
  };
}
