import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import {
  findOutputStyle,
  loadOutputStyles,
  type OutputStyle,
} from "./output-styles.js";
import { tryloHome } from "./session-paths.js";
import type { OutputStyleListOptions, OutputStyleShowOptions } from "./args-output-style.js";
import { reportFailure } from "./run-failure.js";

/**
 * `output-style list|show` handlers (WP24.2 / L48).
 *
 * Read-only views over the loader: the same `loadOutputStyles` the run
 * consumes, so `list` can never name a style `run --output-style` would
 * refuse. Nothing here writes, repairs, or installs.
 */

function styleDirs(ctx: CliContext): { readonly projectDir: string; readonly userDir: string } {
  return {
    projectDir: `${ctx.cwd}/.trylo/output-styles`,
    userDir: `${tryloHome(ctx.homeDir, ctx.env)}/output-styles`,
  };
}

export function loadStylesFor(ctx: CliContext): ReadonlyArray<OutputStyle> {
  return loadOutputStyles(
    {
      readDir: (dir) => ctx.readDir(dir).map((entry) => ({ name: entry.name })),
      readFile: (path) => ctx.readFile(path),
    },
    styleDirs(ctx),
  );
}

type StyleRow = {
  readonly name: string;
  readonly description: string;
  readonly source: string;
};

function rowOf(style: OutputStyle): StyleRow {
  return { name: style.name, description: style.description, source: style.source };
}

export function handleOutputStyleList(ctx: CliContext, options: OutputStyleListOptions): ExitCode {
  const styles = loadStylesFor(ctx);

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ styles: styles.map(rowOf) })}\n`);
    return EXIT_CODES.OK;
  }

  if (styles.length === 0) {
    ctx.stdout("no output styles installed (built-in default applies)\n");
    return EXIT_CODES.OK;
  }

  for (const style of styles) {
    ctx.stdout(`${style.name}  [${style.source}]  ${style.description}\n`);
  }

  return EXIT_CODES.OK;
}

export function handleOutputStyleShow(ctx: CliContext, options: OutputStyleShowOptions): ExitCode {
  const styles = loadStylesFor(ctx);
  const found = findOutputStyle(styles, options.name);
  if (found === undefined) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message:
        options.name === "default"
          ? "default is the built-in style: no file, no prompt, exactly what a run does without --output-style"
          : `no such output style: ${options.name}`,
      hint: "`trylo output-style list` shows what `run --output-style` accepts",
    });
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ style: rowOf(found), prompt: found.prompt })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`${found.prompt}\n`);

  return EXIT_CODES.OK;
}
