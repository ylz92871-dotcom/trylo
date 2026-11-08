import { substituteArguments } from "./substitute.js";
import type { SkillCatalogPort, SkillDescriptor, LoadedSkill } from "../../ports/skills.js";

/**
 * The catalog over one frozen discovery snapshot (WP14.1/C51, WP14.2).
 *
 * `load` composes the text the model will actually consume: the skill's own
 * directory (so relative references resolve), then the body with the skill-dir
 * placeholders resolved and the invocation's arguments substituted. Composition
 * lives here rather than in the tool so the slash surface (L52) expands a
 * `/skill` line into exactly the same text a model invocation would load.
 */

export function createSkillCatalog(skills: ReadonlyArray<SkillDescriptor>): SkillCatalogPort {
  return {
    list: () => skills,
    // Load-only by design: which surfaces may consume a skill is each
    // surface's own gate (the model tool enforces `disable-model-invocation`,
    // the user's slash does not). A gate in this shared port would silently
    // lock the user out of the very field that means "user-only".
    load(name, args) {
      const descriptor = skills.find((skill) => skill.name === name);
      if (descriptor === undefined) {
        return { kind: "unknown_skill", name };
      }
      return { kind: "loaded", skill: compose(descriptor, args) };
    },
  };
}

function compose(descriptor: SkillDescriptor, args: string | undefined): LoadedSkill {
  const dir = descriptor.skillRoot.replaceAll("\\", "/");
  let content = `Base directory for this skill: ${dir}\n\n${descriptor.body}`;

  // `${CLAUDE_SKILL_DIR}` is honoured beside the Trylo spelling so skill
  // libraries written for the old CLI keep working; both names resolve to the
  // same directory and neither can be set by the file itself.
  content = content.replaceAll("${TRYLO_SKILL_DIR}", dir).replaceAll("${CLAUDE_SKILL_DIR}", dir);
  content = substituteArguments(content, args, descriptor.argumentNames ?? [], true);

  return { descriptor, content };
}
