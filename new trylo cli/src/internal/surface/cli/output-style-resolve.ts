import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { findOutputStyle, isStyleName, loadOutputStyles } from "./output-styles.js";
import { fail, type RunFailure } from "./run-failure.js";
import { tryloHome } from "./session-paths.js";

/**
 * Resolve `run --output-style` to an appendable prompt (WP24.2 / L48).
 *
 * Split out of `run-command.ts` so the preparation file stays inside the
 * 400-line gate: one seam, one decision. A style appends its prompt after
 * the assembled seeds (same position as `--append-system-prompt`, which it
 * composes with rather than replaces), and an unknown name refuses the run
 * before a session opens or a request is sent. Absent (or `default`) means
 * no file is read and the request is byte-identical to a run that never
 * heard of styles. Styles never touch permissions, tools, budgets, or
 * provider selection — those are all decided before this is called.
 */
export function resolveOutputStyleAppend(
  ctx: CliContext,
  workspaceRoot: string,
  styleName: string | undefined,
): { readonly append?: string } | RunFailure {
  if (styleName === undefined || styleName === "default") {
    return {};
  }

  if (!isStyleName(styleName)) {
    return fail(
      EXIT_CODES.USAGE,
      `not a usable output style: ${styleName}`,
      "pass a style name from `trylo output-style list`, or drop the flag",
    );
  }

  const styles = loadOutputStyles(
    {
      readDir: (dir) => ctx.readDir(dir).map((entry) => ({ name: entry.name })),
      readFile: (path) => ctx.readFile(path),
    },
    {
      projectDir: `${workspaceRoot}/.trylo/output-styles`,
      userDir: `${tryloHome(ctx.homeDir, ctx.env)}/output-styles`,
    },
  );
  const found = findOutputStyle(styles, styleName);
  if (found === undefined) {
    return fail(
      EXIT_CODES.CONFIG,
      `no such output style: ${styleName}`,
      "`trylo output-style list` shows what `run --output-style` accepts",
    );
  }

  return { append: found.prompt };
}
