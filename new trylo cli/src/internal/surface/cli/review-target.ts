/**
 * Code-review target resolution (WP11.1/11.3, C75).
 *
 * Semantics port of Codex `exec/src/cli.rs` (`ReviewArgs`) and
 * `prompts/src/review_request.rs`: the four mutually exclusive targets —
 * `--uncommitted`, `--base <branch>`, `--commit <sha> [--title]`, or a custom
 * prompt — with the same conflict errors, the same review prompts, and the
 * same user-facing hints. The English prompt strings are Codex's verbatim;
 * they are instructions for the model, not UI copy, so translating them
 * would fork their meaning.
 *
 * What this module is not: it resolves *what* to review and *what to ask*.
 * Collecting the diff (see `git-diff.ts`) and running the review turn belong
 * to the caller. A review produces findings for a person; it never edits
 * files — a review result is not an executed fix, and this module offers no
 * path that confuses the two.
 */

export type ReviewTarget =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "base"; readonly branch: string }
  | { readonly kind: "commit"; readonly sha: string; readonly title?: string }
  | { readonly kind: "custom"; readonly instructions: string };

export type ReviewTargetInput = {
  readonly uncommitted?: boolean;
  readonly base?: string;
  readonly commit?: string;
  readonly commitTitle?: string;
  readonly prompt?: string;
};

export type ReviewTargetOutcome =
  | { readonly ok: true; readonly target: ReviewTarget }
  | { readonly ok: false; readonly code: "target_conflict" | "target_missing" | "review_prompt_empty" | "title_without_commit"; readonly detail: string };

export type ResolvedReviewPrompt =
  | { readonly ok: true; readonly target: ReviewTarget; readonly prompt: string }
  | ReviewTargetFailure;

export const UNCOMMITTED_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_BACKUP =
  "Review the code changes against the base branch '{{branch}}'. Start by finding the merge diff between the current branch and {{branch}}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{{branch}}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {{branch}} branch. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT =
  "Review the code changes against the base branch '{{base_branch}}'. The merge base commit for this comparison is {{merge_base_sha}}. Run `git diff {{merge_base_sha}}` to inspect the changes relative to {{base_branch}}. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {{sha}} ("{{title}}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {{sha}}. Provide prioritized, actionable findings.";

function render(template: string, variables: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [name, value] of Object.entries(variables)) {
    out = out.split(`{{${name}}}`).join(value);
  }
  return out;
}

type ReviewTargetFailure = Extract<ReviewTargetOutcome, { ok: false }>;

function fail(
  code: ReviewTargetFailure["code"],
  detail: string,
): ReviewTargetFailure {
  return { ok: false, code, detail };
}

/**
 * Resolves the review target, enforcing the Codex mutual exclusion:
 * `--uncommitted`, `--base`, `--commit` and a positional prompt conflict
 * with each other; `--title` requires `--commit`.
 */
export function parseReviewTarget(input: ReviewTargetInput): ReviewTargetOutcome {
  const base = input.base?.trim() === "" ? undefined : input.base?.trim();
  const commit = input.commit?.trim() === "" ? undefined : input.commit?.trim();
  const prompt = input.prompt?.trim() === "" ? undefined : input.prompt?.trim();
  const title = input.commitTitle?.trim() === "" ? undefined : input.commitTitle?.trim();
  if (title !== undefined && commit === undefined) {
    return fail("title_without_commit", "--title requires --commit");
  }

  const chosen = [
    input.uncommitted === true ? "--uncommitted" : undefined,
    base === undefined ? undefined : "--base",
    commit === undefined ? undefined : "--commit",
    prompt === undefined ? undefined : "prompt",
  ].filter((name) => name !== undefined);
  if (chosen.length > 1) {
    return fail("target_conflict", `${chosen.join(", ")} cannot be used together: choose one review target`);
  }

  if (input.uncommitted === true) {
    return { ok: true, target: { kind: "uncommitted" } };
  }

  if (base !== undefined) {
    return { ok: true, target: { kind: "base", branch: base } };
  }

  if (commit !== undefined) {
    return { ok: true, target: title === undefined ? { kind: "commit", sha: commit } : { kind: "commit", sha: commit, title } };
  }

  if (prompt !== undefined) {
    return { ok: true, target: { kind: "custom", instructions: prompt } };
  }

  return fail("target_missing", "Specify --uncommitted, --base, --commit, or provide custom review instructions");
}

/**
 * The model prompt for a resolved target. `mergeBaseSha` selects the precise
 * base-branch prompt; without it (merge-base unknown) the backup prompt tells
 * the model how to find the merge diff itself.
 */
export function reviewPrompt(target: ReviewTarget, mergeBaseSha?: string): ResolvedReviewPrompt {
  switch (target.kind) {
    case "uncommitted":
      return { ok: true, target, prompt: UNCOMMITTED_PROMPT };
    case "base":
      if (mergeBaseSha !== undefined && mergeBaseSha.trim().length > 0) {
        return {
          ok: true,
          target,
          prompt: render(BASE_BRANCH_PROMPT, { base_branch: target.branch, merge_base_sha: mergeBaseSha.trim() }),
        };
      }
      return { ok: true, target, prompt: render(BASE_BRANCH_PROMPT_BACKUP, { branch: target.branch }) };
    case "commit":
      return {
        ok: true,
        target,
        prompt: target.title === undefined
          ? render(COMMIT_PROMPT, { sha: target.sha })
          : render(COMMIT_PROMPT_WITH_TITLE, { sha: target.sha, title: target.title }),
      };
    case "custom":
      if (target.instructions.trim().length === 0) {
        return fail("review_prompt_empty", "Review prompt cannot be empty");
      }
      return { ok: true, target, prompt: target.instructions.trim() };
  }
}

/** Short human label for the target, for status lines and summaries. */
export function reviewHint(target: ReviewTarget): string {
  switch (target.kind) {
    case "uncommitted":
      return "current changes";
    case "base":
      return `changes against '${target.branch}'`;
    case "commit": {
      const short = target.sha.slice(0, 7);
      return target.title === undefined ? `commit ${short}` : `commit ${short}: ${target.title}`;
    }
    case "custom":
      return target.instructions.trim();
  }
}
