import { recordOf } from "../../domain/evolution/parse.js";
import { isNpmRepositoryClaim } from "../../../../../../tooling/contract/npm-source.js";

/** npm repository shorthand is a source label, never a URL passed to the downloader. */
export function npmGithubRepository(raw: unknown): string | undefined {
  const value = recordOf(raw) ? raw.url : raw;
  if (typeof value !== "string") return undefined;

  const normalized = value.replace(/^git\+/, "").replace(/^github:/, "https://github.com/")
    .replace(/^(?:git|http):\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/").replace(/^https:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? `https://github.com/${normalized}` : normalized;

  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url) ? url : undefined;
}

/** An inert publisher label may name a non-GitHub repository; it grants no fetch capability. */
export function npmRepositoryClaim(raw: unknown): string | undefined {
  const github = npmGithubRepository(raw);
  if (github !== undefined) return github;
  const value = recordOf(raw) ? raw.url : raw;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^git\+/, "").replace(/\.git$/, "");
  return isNpmRepositoryClaim(normalized) ? normalized : undefined;
}
