import type { ProjectInstructionSource } from "./host.js";
import type { CheckStatus } from "./doctor-types.js";

/**
 * The two fields of a `ProjectContext` a diagnostic needs.
 *
 * Structurally a subset rather than the whole `ProjectContext`, because this
 * module must not depend on the host: the check is rendered by `doctor`, which
 * never runs a turn. Taking the subset also means the caller cannot accidentally
 * hand over the assembled `messages` and have a diagnostic print rule prose —
 * the text is not reachable from here at all, which is the guarantee stated
 * above rather than a promise about future callers.
 */
export type ProjectRulesReport = {
  readonly sources: ReadonlyArray<ProjectInstructionSource>;
  readonly problems: ReadonlyArray<string>;
};

/**
 * Where a run's project rules came from, as one diagnostic line (WP-CLI-B1 §3.3).
 *
 * The one place that answers "which rules is this run using". A run adopts its
 * rules through `projectContextFor` and records the source list; this turns that
 * list into a sentence, and doctor turns the same list into the same sentence.
 * Two renderings would be two answers, and the wrong one is invisible — a user
 * comparing `trylo doctor` against what the model was actually told would have
 * no way to tell which lied.
 *
 * Deliberately small: relative path, scope, and the short content hash. **Not**
 * the rule text. A diagnostic is something a user pastes into a bug report, and
 * a project's `AGENTS.md` can hold an internal host name, a release process, or
 * a credential it was told to expect — none of which belongs in a terminal
 * scrollback or a `--json` blob. The hash is there precisely so a user can prove
 * "these are the same rules you saw last time" without the prose.
 */

/** How much of the hash is worth printing: enough to compare, short enough to read. */
const SHORT_HASH = 8;

export type ProjectRulesCheck = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
};

function scopeWording(source: ProjectInstructionSource): string {
  return source.scope === "workspace_root" ? "whole workspace" : `${source.scopePath}/ and below`;
}

/**
 * One line per adopted rule file, plus a count.
 *
 * Multi-line rather than one long line because the scope is the fact a user
 * actually needs: "the rules came from somewhere" is reassurance, "the rules
 * came from `src/` and do not apply to `docs/`" is the answer to "why did the
 * model ignore my root conventions".
 */
export function projectRulesCheck(
  sources: ReadonlyArray<ProjectInstructionSource> | undefined,
  problems: ReadonlyArray<string> | undefined,
): ProjectRulesCheck {
  const failures = problems ?? [];
  if (failures.length > 0) {
    // A rule file that exists but could not be read is `fail`, not `skip`: the
    // project stated rules and the run will silently proceed without some of
    // them. That is the exact case where a user needs to be told rather than
    // left to infer it from the model's behaviour.
    return {
      id: "project.rules",
      status: "fail",
      detail: `unusable rule files: ${failures.join(", ")}`,
    };
  }

  const adopted = sources ?? [];
  if (adopted.length === 0) {
    return {
      id: "project.rules",
      status: "skip",
      detail: "no AGENTS.md / CLAUDE.md / GEMINI.md in this workspace or its ancestors up to the root",
    };
  }

  const lines = adopted.map(
    (source) =>
      `  ${source.relativePath} (${scopeWording(source)}, ${source.contentHash.slice(0, SHORT_HASH)})`,
  );

  return {
    id: "project.rules",
    status: "ok",
    detail: `${adopted.length} rule file${adopted.length === 1 ? "" : "s"} adopted:\n${lines.join("\n")}`,
  };
}
