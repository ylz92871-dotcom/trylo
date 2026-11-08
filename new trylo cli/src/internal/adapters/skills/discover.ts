import { realpathSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SkillDescriptor, SkillSource } from "../../ports/skills.js";
import { parseSkillDocument } from "./parse.js";

/**
 * Layered skill discovery (WP14.1 / C51/C52).
 *
 * The mechanical core of the old CLI's `loadSkillsDir`, reduced to what the new
 * CLI owns: only the directory format (`<name>/SKILL.md`), only the roots the
 * composition root passes, and every rejected file reported as a problem rather
 * than silently skipped. No singleton caches — the caller freezes a snapshot per
 * turn, which is what makes an uninstall take effect without any clearing step.
 *
 * Roots are passed in precedence order, highest first. Two duplicate shapes are
 * distinguished because they mean different things to a user auditing their
 * skills: the same file reached through two roots (`skill_duplicate_file`), and
 * two different files claiming one name (`skill_name_shadowed`).
 */

export type SkillReader = {
  /** Entry names of `root` that are directories, or an empty list when it cannot be read. */
  listDirectories(root: string): ReadonlyArray<string>;
  /**
   * The file's text, or `undefined` when it does not exist. Any other failure
   * (EACCES, EIO…) **throws**: discovery turns it into an explainable
   * `skill_unreadable` problem rather than an indistinguishable "no skill"
   * (复核 F6) — the caller above decides, not the reader.
   */
  readText(absolutePath: string): string | undefined;
  /** Symlink-resolved identity, used to recognise one file reached twice. */
  canonical(absolutePath: string): string;
};

export type SkillRoot = {
  readonly source: SkillSource;
  readonly directory: string;
};

export type SkillDiscovery = {
  readonly skills: ReadonlyArray<SkillDescriptor>;
  readonly problems: ReadonlyArray<string>;
};

export function createNodeSkillReader(): SkillReader {
  return {
    listDirectories(root) {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name);
      } catch {
        // A missing or unreadable root is "no skills here", not a run failure;
        // the user-layer root in particular does not exist for most installs.
        return [];
      }
    },
    readText(absolutePath) {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch (error) {
        if (isNoSuchFile(error)) {
          return undefined;
        }
        // An existing file we cannot read is not "no skill here": report it.
        throw error;
      }
    },
    canonical(absolutePath) {
      try {
        return realpathSync(absolutePath);
      } catch {
        return path.resolve(absolutePath);
      }
    },
  };
}

export function discoverSkills(roots: ReadonlyArray<SkillRoot>, reader: SkillReader): SkillDiscovery {
  const skills: SkillDescriptor[] = [];
  const problems: string[] = [];
  const seenFiles = new Set<string>();
  const names = new Map<string, SkillDescriptor>();

  for (const root of roots) {
    for (const entry of reader.listDirectories(root.directory)) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      let raw: string | undefined;

      try {
        raw = reader.readText(skillPath);
      } catch {
        problems.push(`skill_unreadable:${toForwardSlashes(skillPath)}`);
        continue;
      }

      if (raw === undefined) {
        // No SKILL.md: an ordinary directory in a skills root, not an error.
        continue;
      }

      const canonical = reader.canonical(skillPath);
      if (seenFiles.has(canonical)) {
        problems.push(`skill_duplicate_file:${toForwardSlashes(skillPath)}`);
        continue;
      }

      const parsed = parseSkillDocument(raw);
      if (parsed.kind === "invalid") {
        problems.push(`skill_invalid:${toForwardSlashes(skillPath)}:${parsed.reason}`);
        continue;
      }

      seenFiles.add(canonical);
      const descriptor: SkillDescriptor = {
        name: parsed.skill.name ?? entry,
        description: parsed.skill.description,
        ...(parsed.skill.whenToUse === undefined ? {} : { whenToUse: parsed.skill.whenToUse }),
        source: root.source,
        skillRoot: path.join(root.directory, entry),
        path: skillPath,
        contentHash: hashText(raw),
        body: parsed.skill.body,
        userInvocable: parsed.skill.userInvocable,
        disableModelInvocation: parsed.skill.disableModelInvocation,
        forkExecution: parsed.skill.forkExecution,
        ...(parsed.skill.argumentHint === undefined ? {} : { argumentHint: parsed.skill.argumentHint }),
        ...(parsed.skill.argumentNames === undefined ? {} : { argumentNames: [...parsed.skill.argumentNames] }),
        ...(parsed.skill.allowedTools.length === 0 ? {} : { allowedTools: parsed.skill.allowedTools }),
        ...(parsed.skill.paths === undefined ? {} : { paths: parsed.skill.paths }),
      };
      const held = names.get(descriptor.name);
      if (held !== undefined) {
        problems.push(`skill_name_shadowed:${descriptor.name}:${toForwardSlashes(skillPath)}`);
        continue;
      }

      names.set(descriptor.name, descriptor);
      skills.push(descriptor);
    }
  }

  return { skills, problems };
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function toForwardSlashes(absolutePath: string): string {
  return absolutePath.replaceAll("\\", "/");
}

function isNoSuchFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
