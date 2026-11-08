import path from "node:path";
import { parseRoleDocument } from "./parse.js";
import type { SubagentRole } from "../../subagent/role.js";

/**
 * Where a run's subagent roles come from (WP22.2b / L27).
 *
 * Two layers, project before user, the same precedence skills use: a project
 * that defines its own `reviewer` means it, whatever the user profile also has.
 * Discovery is rebuilt at the turn boundary rather than cached, so deleting a
 * role file takes the role out of the next run with nothing to clear.
 *
 * A file that cannot be used is reported by name rather than dropped: a role
 * the user wrote and the model cannot see is a silence, and silence is the
 * one thing a configuration mistake must never be.
 */

export type RoleSource = "project" | "user";

export type RoleRoot = {
  readonly source: RoleSource;
  readonly directory: string;
};

export type RoleDiscovery = {
  readonly roles: ReadonlyArray<SubagentRole>;
  readonly problems: ReadonlyArray<string>;
};

export type RoleReader = {
  /** File names directly under `root`; empty when the directory is not there. */
  listEntries(root: string): ReadonlyArray<string>;
  /** The file's text, or `undefined` when it does not exist. Anything else throws. */
  readFile(path: string): string | undefined;
};

export const ROLE_FILE_SUFFIX = ".md";

export function discoverRoles(
  roots: ReadonlyArray<RoleRoot>,
  reader: RoleReader,
): RoleDiscovery {
  const byName = new Map<string, SubagentRole>();
  const problems: string[] = [];

  for (const root of roots) {
    let entries: ReadonlyArray<string>;

    try {
      entries = reader.listEntries(root.directory);
    } catch (error) {
      problems.push(`${root.source}: ${root.directory} could not be listed (${String(error)})`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(ROLE_FILE_SUFFIX)) {
        continue;
      }

      const file = path.join(root.directory, entry);
      let raw: string | undefined;

      try {
        raw = reader.readFile(file);
      } catch (error) {
        problems.push(`${root.source}: ${file} could not be read (${String(error)})`);
        continue;
      }

      if (raw === undefined) {
        continue;
      }

      const fallbackName = entry.slice(0, -ROLE_FILE_SUFFIX.length);
      const parsed = parseRoleDocument(raw, fallbackName);
      if (parsed.kind === "invalid") {
        problems.push(`${root.source}: ${file} — ${parsed.reason}`);
        continue;
      }

      // First layer wins, and `roots` is ordered project-first by the caller.
      if (!byName.has(parsed.role.name)) {
        byName.set(parsed.role.name, parsed.role);
      }
    }
  }

  return { roles: [...byName.values()], problems };
}
