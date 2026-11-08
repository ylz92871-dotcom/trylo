import { skillsPortFor } from "./skills-wiring.js";

/**
 * `/skill-name args` in the REPL (L52, user-invocable half).
 *
 * A typed `/name` that is not a slash *command* may still be an installed
 * skill the user invokes. Expansion re-reads the workspace's skills at line
 * time (the same per-turn freshness the run host keeps), loads through the same
 * catalog the `skill` tool uses, and marks the result as user-invoked so the
 * model can tell an invoked skill from its own ideas.
 *
 * `undefined` means "not a skill": the caller keeps its unknown-command
 * contract and the line is never forwarded as a prompt.
 */

export type SkillSlashExpansion = {
  readonly name: string;
  readonly text: string;
};

export function expandSkillSlash(input: string, workspaceRoot: string, homeDir: string, env: Readonly<Record<string, string | undefined>>): SkillSlashExpansion | undefined {
  if (!input.startsWith("/")) {
    return undefined;
  }

  const separator = input.indexOf(" ");
  const name = (separator === -1 ? input : input.slice(0, separator)).slice(1).trim();
  const args = separator === -1 ? undefined : input.slice(separator + 1).trim();

  if (name.length === 0) {
    return undefined;
  }

  const skills = skillsPortFor(homeDir, env, workspaceRoot);
  const descriptor = skills.catalog?.list().find((skill) => skill.name === name && skill.userInvocable);
  if (descriptor === undefined || skills.catalog === undefined) {
    return undefined;
  }

  const loaded = skills.catalog.load(name, args);
  if (loaded.kind !== "loaded") {
    return undefined;
  }

  return {
    name,
    text: `${loaded.skill.content}\n\n(The user invoked skill "${name}"${args === undefined ? "" : ` with: ${args}`}; the text above is the skill's instructions for this turn.)`,
  };
}
