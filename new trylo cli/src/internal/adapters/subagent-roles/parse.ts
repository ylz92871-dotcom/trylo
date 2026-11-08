import { parseFrontmatterLines, splitFrontmatter } from "../skills/parse.js";
import type { SubagentRole } from "../../subagent/role.js";

/**
 * `<name>.md` role files (WP22.2b / C44, L27).
 *
 * The frontmatter grammar is the skills one, reused rather than reimplemented:
 * `SKILL.md` and a role file are the same shape of document (a delimited
 * header of scalars and string lists, then a body), and two hand-written
 * frontmatter parsers would be two answers to "is `tools: [a, b` unterminated
 * an error or not".
 *
 * What is *not* reused is the meaning. A role file cannot grant anything — see
 * `subagent/role.ts`, which intersects whatever this parser returns with what
 * the parent already allows.
 */

export type RoleParse =
  | { readonly kind: "ok"; readonly role: SubagentRole }
  | { readonly kind: "invalid"; readonly reason: string };

const FRONTMATTER_LIMIT = 8 * 1024;

function scalar(data: Record<string, string | string[]>, key: string): string | undefined {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

function list(
  data: Record<string, string | string[]>,
  key: string,
): ReadonlyArray<string> | undefined {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    // `tools: read_file` is one tool, not a sentence about tools.
    return value.split(/[\s,]+/).filter((item) => item.length > 0);
  }

  return value.filter((item) => item.trim().length > 0).map((item) => item.trim());
}

function count(data: Record<string, string | string[]>, key: string): number | undefined {
  const raw = scalar(data, key);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return Number.NaN;
  }

  return parsed;
}

export function parseRoleDocument(raw: string, fallbackName: string): RoleParse {
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = fallbackName;
  const instructions = body.trim();

  if (frontmatter === null) {
    if (instructions.length === 0) {
      return { kind: "invalid", reason: "role file has neither frontmatter nor a body" };
    }
    return {
      kind: "ok",
      role: {
        name,
        description: instructions.slice(0, 200),
        prompt: instructions,
      },
    };
  }

  if (frontmatter.length > FRONTMATTER_LIMIT) {
    return { kind: "invalid", reason: "frontmatter exceeds the size limit" };
  }

  const data = parseFrontmatterLines(frontmatter);
  if (typeof data === "string") {
    return { kind: "invalid", reason: `invalid frontmatter (${data})` };
  }

  const description = scalar(data, "description");
  if (description === undefined) {
    // Codex makes description required for loaded user roles
    // (`agent_role_config.rs:12`): a role the model cannot tell apart from
    // another is not a role.
    return { kind: "invalid", reason: "role file needs a description" };
  }

  const declaredName = scalar(data, "name") ?? name;
  const turns = count(data, "max-iterations");
  if (Number.isNaN(turns)) {
    return { kind: "invalid", reason: "max-iterations must be a positive integer" };
  }

  return {
    kind: "ok",
    role: {
      name: declaredName,
      description,
      ...(scalar(data, "model") === undefined ? {} : { model: scalar(data, "model") }),
      ...(list(data, "tools") === undefined ? {} : { allowedTools: list(data, "tools") }),
      ...(list(data, "disallowed-tools") === undefined
        ? {}
        : { disallowedTools: list(data, "disallowed-tools") }),
      ...(list(data, "skills") === undefined ? {} : { skills: list(data, "skills") }),
      ...(turns === undefined ? {} : { maxIterations: turns }),
      ...(list(data, "nicknames") === undefined
        ? {}
        : { nicknameCandidates: list(data, "nicknames") }),
      ...(instructions.length === 0 ? {} : { prompt: instructions }),
    },
  };
}
