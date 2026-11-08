import path from "node:path";
import { createSkillCatalog } from "../../adapters/skills/catalog.js";
import { createNodeSkillReader, discoverSkills, type SkillRoot } from "../../adapters/skills/discover.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import { learnedSkillCatalog, type LearnedSkillCatalogInput } from "../../integration/skill-learning/catalog.js";
import { tryloHome } from "./session-paths.js";

/**
 * Where a run's skills come from (WP14.1/C51).
 *
 * Two discovered layers, most specific first: the workspace's `.trylo/skills`,
 * then the profile root's `skills`. Like `projectContextFor`, this is frozen at
 * the turn boundary and rebuilt for the next turn — that rebuild is the whole
 * uninstall story (WP14.3): a deleted skill directory stops being offered and
 * stoppable of injection without any cache to clear.
 *
 * An empty discovery returns no catalog at all, so a workspace without skills
 * produces a tool table byte-identical to one that never heard of the feature.
 * Problems are the caller's to surface: they name the files a user wrote and
 * we could not use.
 */

export type SkillsWiring = {
  readonly catalog: SkillCatalogPort | undefined;
  readonly problems: ReadonlyArray<string>;
};

export function skillsPortFor(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
  learned?: Omit<LearnedSkillCatalogInput, "contentRoot">,
): SkillsWiring {
  const roots: ReadonlyArray<SkillRoot> = [
    { source: "project", directory: path.join(workspaceRoot, ".trylo", "skills") },
    { source: "user", directory: path.join(tryloHome(homeDir, env), "skills") },
  ];
  const discovery = discoverSkills(roots, createNodeSkillReader());
  const installed = createSkillCatalog(discovery.skills);
  const learning = learned === undefined ? undefined : learnedSkillCatalog({ ...learned, contentRoot: workspaceRoot });
  const learnedCatalog = learning?.catalog;
  const descriptors = [...discovery.skills, ...(learnedCatalog?.list() ?? [])];
  const problems = [...discovery.problems, ...(learning?.problems ?? [])];

  if (descriptors.length === 0) return { catalog: undefined, problems };

  return { problems, catalog: {
    list: () => descriptors,

    load(name, args) {
      const result = installed.load(name, args);
      return result.kind === "loaded" ? result : learnedCatalog?.load(name, args) ?? result;
    },
  } };
}
