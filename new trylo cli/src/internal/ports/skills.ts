import type { ToolOutcome } from "./tools.js";

/**
 * Skills (WP14): installed SKILL.md documents the run can actually consume.
 *
 * The catalog port is the seam between discovery (an adapter that reads skill
 * directories) and the loop's tool table (the `skill` tool). Like
 * `ports/memory.ts`, the port is lent to the tools, never constructed by them:
 * where skills live is the composition root's decision, and WP16's plugin
 * sources will satisfy this same port rather than grow a second one.
 *
 * Lifetime: a catalog is frozen per turn, like the project instructions. The
 * composition root rebuilds it at each turn boundary, which is what makes an
 * uninstalled skill stop being injected without any cache to clear.
 */

/** Where a skill was found. `additional` is reserved for explicit caller-supplied directories. */
export type SkillSource = "project" | "user" | "additional" | "builtin";

export type SkillDescriptor = {
  readonly name: string;
  readonly description: string;
  /** `when_to_use` — the selection hint the model reads before invoking. */
  readonly whenToUse?: string;
  readonly source: SkillSource;
  /** Absolute directory holding this SKILL.md; the `${TRYLO_SKILL_DIR}` value. */
  readonly skillRoot: string;
  readonly path: string;
  readonly contentHash: string;
  /** SKILL.md body with frontmatter removed, read once per turn. */
  readonly body: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  /** `context: fork` — the skill asks to run as a delegated subagent. */
  readonly forkExecution: boolean;
  readonly argumentHint?: string;
  readonly argumentNames?: ReadonlyArray<string>;
  /** Surfaced, not yet enforced (L53 unclosed): the permission narrowing a skill asks for. */
  readonly allowedTools?: ReadonlyArray<string>;
  /** Surfaced, not yet enforced (L53 unclosed): the path scopes a skill is written for. */
  readonly paths?: ReadonlyArray<string>;
};

export type LoadedSkill = {
  readonly descriptor: SkillDescriptor;
  /**
   * Final content: the base-directory header, then the body with
   * `${TRYLO_SKILL_DIR}` (and the legacy `${CLAUDE_SKILL_DIR}`) resolved and
   * argument placeholders substituted. This is the text the model consumes.
   */
  readonly content: string;
};

export type SkillLoad =
  | { readonly kind: "loaded"; readonly skill: LoadedSkill }
  | { readonly kind: "unknown_skill"; readonly name: string };
  // Deliberately no "model_invocation_disabled": the loader loads, surfaces
  // gate. The model tool checks `descriptor.disableModelInvocation` itself so
  // the user's slash can still invoke the same skill.

export type SkillCatalogPort = {
  /** Every discovered skill, including model-invocation-disabled ones. */
  list(): ReadonlyArray<SkillDescriptor>;
  load(name: string, args: string | undefined): SkillLoad;
};

/**
 * `context: fork` execution, owned by the subagent runtime (WP22's port). The
 * skill tool never spawns a subagent itself; wiring decides whether a delegate
 * exists, and an absent delegate is a terminal refusal, never inline fallback.
 */
export type SkillForkRequest = {
  readonly toolCallId: string;
  readonly name: string;
  readonly prompt: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly signal: AbortSignal;
};

export type SkillForkExecutor = (request: SkillForkRequest) => Promise<ToolOutcome>;
