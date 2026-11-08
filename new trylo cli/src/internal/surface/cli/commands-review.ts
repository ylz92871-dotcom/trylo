import { createGitRunner } from "../../adapters/git/runner.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { collectGitDiff, mergeBaseArgv, type GitCommandRunner, type GitDiffOutcome } from "./git-diff.js";
import { parseReviewTarget, reviewHint, reviewPrompt } from "./review-target.js";
import { diffSnapshot } from "../../adapters/checkpoint/scope-restore.js";
import type { DiffCommandOptions, ReviewCommandOptions } from "./args-review.js";
import type { CheckpointDiffOptions } from "./args-checkpoint.js";
import type { CliContext } from "./context.js";
import { reportFailure } from "./run-failure.js";
import { tryloHome } from "./session-paths.js";
import { manifestRows, readCurrentRows, readManifest } from "./checkpoint-workspace.js";

/**
 * WP11 review handlers: `diff`, `review`, `checkpoint diff`, `session review`.
 *
 * All four are reads. None of them writes the workspace, stages anything, or
 * rewrites the journal — reviewing is how a person decides what to rewind,
 * and the rewind itself stays the explicit `checkpoint restore` / `session
 * fork` they already know. A review that presented itself as a fix would be
 * the exact confusion WP11.1 forbids, so every rendering below closes with
 * what it did *not* do.
 */

type Platform = "win32" | "posix";

function platformOf(ctx: CliContext): Platform {
  return ctx.platform === "win32" ? "win32" : "posix";
}

function gitError(ctx: CliContext, outcome: Extract<GitDiffOutcome, { ok: false }>): ExitCode {
  if (outcome.code === "cancelled") {
    return reportFailure(ctx, { exitCode: EXIT_CODES.CANCELLED, message: outcome.detail, hint: "the diff was cancelled; nothing was read" });
  }

  if (outcome.code === "git_unavailable") {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `git is not usable here: ${outcome.detail}`,
      hint: "install git and run `trylo doctor`; `checkpoint diff` and `session review` do not need git",
    });
  }

  return reportFailure(ctx, {
    exitCode: EXIT_CODES.EXECUTION_FAILURE,
    message: outcome.detail,
    hint: "git ran but reported failure; run the same `git diff` by hand for the full error",
  });
}

export function renderDiffText(outcome: Extract<GitDiffOutcome, { ok: true }>): string {
  const { isGitRepo, diff } = outcome.value;

  if (!isGitRepo) {
    return "not a git repository\n";
  }

  if (diff === "") {
    return "no changes\n";
  }

  return diff.endsWith("\n") ? diff : `${diff}\n`;
}

export async function handleDiff(
  ctx: CliContext,
  options: DiffCommandOptions,
  deps?: { readonly runner?: GitCommandRunner },
): Promise<ExitCode> {
  const outcome = await collectGitDiff(deps?.runner ?? createGitRunner(), {
    cwd: ctx.cwd,
    platform: platformOf(ctx),
    baseEnv: ctx.env,
  });
  if (!outcome.ok) {
    return gitError(ctx, outcome);
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify(outcome.value)}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(renderDiffText(outcome));

  return EXIT_CODES.OK;
}

/** Review diffs are bounded: a review shows evidence, not a second copy of the tree. */
const REVIEW_DIFF_CHARS = 12_000;

async function mergeBaseSha(
  runner: GitCommandRunner,
  ctx: CliContext,
  branch: string,
): Promise<string | undefined> {
  // Best-effort by contract: the caller falls back to the backup prompt that
  // teaches the model to find the merge base itself. Every failure — missing
  // git, unknown branch, spawn error — therefore ends here with `undefined`,
  // which is a terminal branch, not a swallowed one. (Codex propagates with
  // `?` instead; the prompts differ only in precision, never in honesty.)
  try {
    const result = await runner.run(mergeBaseArgv(platformOf(ctx), branch), ctx.cwd, undefined);
    if (result.exit !== 0) {
      return undefined;
    }
    const sha = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function handleReview(
  ctx: CliContext,
  options: ReviewCommandOptions,
  deps?: { readonly runner?: GitCommandRunner },
): Promise<ExitCode> {
  let prompt = options.prompt;

  if (options.promptFromStdin === true) {
    const stdinText = (await ctx.readStdin()).trim();
    if (stdinText.length === 0) {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.USAGE,
        message: "review prompt read from stdin is empty",
        hint: "pipe instructions in, or pass them as an argument",
      });
    }

    prompt = stdinText;
  }

  const resolved = parseReviewTarget({
    uncommitted: options.uncommitted,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    ...(options.commitTitle === undefined ? {} : { commitTitle: options.commitTitle }),
    ...(prompt === undefined ? {} : { prompt }),
  });
  if (!resolved.ok) {
    return reportFailure(ctx, { exitCode: EXIT_CODES.USAGE, message: resolved.detail, hint: "one target only: --uncommitted, --base, --commit, or a prompt" });
  }

  const runner = deps?.runner ?? createGitRunner();
  const mergeBase = resolved.target.kind === "base"
    ? await mergeBaseSha(runner, ctx, resolved.target.branch)
    : undefined;
  const prompted = reviewPrompt(resolved.target, mergeBase);
  if (!prompted.ok) {
    return reportFailure(ctx, { exitCode: EXIT_CODES.USAGE, message: prompted.detail, hint: "give the review something to chew on" });
  }

  const hint = reviewHint(resolved.target);
  let diffText: string | undefined;
  let gitAdvice: string | undefined;

  if (resolved.target.kind === "uncommitted") {
    const outcome = await collectGitDiff(runner, { cwd: ctx.cwd, platform: platformOf(ctx), baseEnv: ctx.env });
    if (!outcome.ok) {
      return gitError(ctx, outcome);
    }

    if (outcome.value.isGitRepo && outcome.value.diff.length > REVIEW_DIFF_CHARS) {
      diffText = `${outcome.value.diff.slice(0, REVIEW_DIFF_CHARS)}\n... [review diff truncated] ...\n`;
    } else {
      diffText = outcome.value.isGitRepo ? outcome.value.diff : undefined;
    }

    if (!outcome.value.isGitRepo) {
      gitAdvice = "not a git repository: the review covers the prompt only, with no workspace diff attached";
    } else if (outcome.value.diff === "") {
      gitAdvice = "the workspace has no changes: there is nothing to review yet";
    }
  } else if (resolved.target.kind === "base") {
    gitAdvice = mergeBase === undefined
      ? `merge-base for '${resolved.target.branch}' is unknown here; inspect with \`git diff ${resolved.target.branch}\` first`
      : `inspect with \`git diff ${mergeBase}\``;
  } else if (resolved.target.kind === "commit") {
    gitAdvice = `inspect with \`git show ${resolved.target.sha}\``;
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({
      target: resolved.target,
      hint,
      prompt: prompted.prompt,
      ...(diffText === undefined ? {} : { diff: diffText }),
      ...(gitAdvice === undefined ? {} : { git: gitAdvice }),
      executedFix: false,
    })}\n`);
    return EXIT_CODES.OK;
  }

  const lines = [`reviewing ${hint}`, "", prompted.prompt, ""];

  if (diffText !== undefined && diffText.length > 0) {
    lines.push("--- workspace diff ---", "", diffText.endsWith("\n") ? diffText.slice(0, -1) : diffText, "");
  }

  if (gitAdvice !== undefined) {
    lines.push(gitAdvice, "");
  }

  lines.push("a review is findings, not fixes: this command changed nothing.");
  ctx.stdout(`${lines.join("\n")}\n`);

  return EXIT_CODES.OK;
}

const CHECKPOINT_STORAGE_DIR = "checkpoints";

export async function handleCheckpointDiff(
  ctx: CliContext,
  options: CheckpointDiffOptions,
): Promise<ExitCode> {
  const storageRoot = `${tryloHome(ctx.homeDir, ctx.env)}/${CHECKPOINT_STORAGE_DIR}`;
  const manifest = readManifest(storageRoot, options.checkpointId);
  if (!manifest.ok) {
    const hint = manifest.code === "checkpoint_not_found" || manifest.code === "checkpoint_id_mismatch"
      ? "`trylo checkpoint list` shows the ids this workspace can restore"
      : "the snapshot storage may be damaged; list other checkpoints before restoring anything";
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: manifest.code === "checkpoint_not_found"
        ? `no such checkpoint: ${options.checkpointId}`
        : `checkpoint ${options.checkpointId} is not readable: ${manifest.detail}`,
      hint,
    });
  }

  // The manifest's own ignore set (F12): previewing with a different set
  // than the snapshot was taken with would report excluded files as added.
  const current = readCurrentRows(ctx.cwd, manifest.manifest.ignores);
  if (!current.ok) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `the workspace cannot be read: ${current.detail}`,
      hint: "fix workspace access, then diff again",
    });
  }

  const diff = diffSnapshot(manifestRows(manifest.manifest), current.rows);
  const unreadable = current.unreadable;

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ checkpointId: options.checkpointId, digest: manifest.manifest.digest, diff, unreadable })}\n`);
    return EXIT_CODES.OK;
  }

  const lines = [`checkpoint ${options.checkpointId} vs workspace`, ""];

  for (const row of diff.modified) {
    lines.push(`M ${row.path} (${row.beforeBytes} -> ${row.afterBytes} bytes)`);
  }

  for (const row of diff.added) {
    // A rows are the dangerous ones: a bare `restore` deletes them. Say so
    // on the row itself, not three screens further down.
    lines.push(`A ${row.path} (${row.bytes} bytes, created since the snapshot; a bare restore DELETES it)`);
  }

  for (const row of diff.removed) {
    lines.push(`D ${row.path} (${row.bytes} bytes in the snapshot, absent now)`);
  }

  if (diff.modified.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push("identical: restoring this checkpoint would change nothing");
  }

  for (const path of unreadable) {
    lines.push(`? ${path} (unreadable, excluded from the comparison)`);
  }

  lines.push(
    "",
    "a diff changes nothing. Rewind selected files with",
    `  \`trylo checkpoint restore ${options.checkpointId} --only <paths>\`;`,
    "a bare `restore` also deletes everything marked A above.",
  );
  ctx.stdout(`${lines.join("\n")}\n`);

  return EXIT_CODES.OK;
}
