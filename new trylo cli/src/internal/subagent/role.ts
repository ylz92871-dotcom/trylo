/**
 * Subagent roles: a named, reusable set of overrides a parent can hand a child
 * (WP22.2b / C44, L27).
 *
 * Source: Codex `codex-rs/agent-roles/src/agent_role_config.rs:10` (a role is a
 * description, a config layer and some candidate nicknames) and
 * `core/src/agent/role.rs:2`, whose first line is the rule this file exists to
 * enforce:
 *
 *   "Roles may customize the child or reduce its capabilities, but never
 *    replace the parent session's authority."
 *
 * So a role may narrow or restyle a child. It may never widen one. The one
 * place that could widen is the tool list, and that is the one place this file
 * intersects rather than trusts: `resolveRole` takes the parent's allowances
 * and subtracts, because a role file is user-authored text and user-authored
 * text is not a security boundary.
 */

export type SubagentRole = {
  readonly name: string;
  /** Human-facing, shown to the model so it can choose a role. */
  readonly description: string;
  /** Extra instructions prepended to the child's own task. */
  readonly prompt?: string | undefined;
  /** `"inherit"` and absent both mean: use whatever the parent is running. */
  readonly model?: string | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly disallowedTools?: ReadonlyArray<string> | undefined;
  /**
   * Skills this role asks for. The generic runtime carries no catalog and
   * treats names as wishes. Frozen team wiring resolves installed skill text
   * before dispatch and intersects its tool restrictions with the role floor.
   */
  readonly skills?: ReadonlyArray<string> | undefined;
  /** Turn ceiling for one child. Lowering it is narrowing; raising it is not. */
  readonly maxIterations?: number | undefined;
  readonly nicknameCandidates?: ReadonlyArray<string> | undefined;
};

export type ResolvedRole = {
  readonly role: SubagentRole;
  readonly model: string | undefined;
  readonly allowedTools: ReadonlyArray<string>;
  readonly maxIterations: number | undefined;
  /**
   * What the role asked for that the parent would not grant. Reported rather
   * than thrown: refusing to spawn over a config file's optimism would turn a
   * typo into an outage, and narrowing is the safe direction anyway.
   */
  readonly withheld: ReadonlyArray<string>;
};

export const DEFAULT_ROLE_NAME = "default";

export function findRole(
  catalog: ReadonlyArray<SubagentRole>,
  name: string | undefined,
): SubagentRole | undefined {
  const wanted = name ?? DEFAULT_ROLE_NAME;
  return catalog.find((role) => role.name === wanted);
}

/**
 * The tool list a role actually gets: the parent's, minus what the role forbids.
 *
 * `allowedTools` is a *wish*, not a grant. A role naming a tool the parent
 * cannot use gets the intersection, and the difference comes back in
 * `withheld` so the spawn result can say so out loud.
 */
function toolsFor(
  parentTools: ReadonlyArray<string>,
  role: SubagentRole,
): { readonly tools: ReadonlyArray<string>; readonly withheld: ReadonlyArray<string> } {
  const parent = new Set(parentTools);
  const forbidden = new Set(role.disallowedTools ?? []);
  const withheld: string[] = [];

  const granted = (role.allowedTools ?? [])
    .filter((name) => {
      const usable = parent.has(name) && !forbidden.has(name);
      if (!usable) {
        // Named either way: a tool the parent cannot grant, or one this role
        // asked for and forbade in the same breath. Both are things the author
        // of the file would want to know, and both end the same way — not given.
        withheld.push(name);
      }
      return usable;
    });

  // Without a wish list the role inherits the parent minus its own denials.
  if (role.allowedTools === undefined) {
    return {
      tools: [...parentTools].filter((name) => !forbidden.has(name)),
      withheld,
    };
  }
  return { tools: granted, withheld };
}

export function resolveRole(
  catalog: ReadonlyArray<SubagentRole>,
  name: string | undefined,
  parent: {
    readonly model: string | undefined;
    readonly allowedTools: ReadonlyArray<string>;
    readonly maxIterations: number | undefined;
  },
): ResolvedRole {
  const role = findRole(catalog, name);
  if (role === undefined) {
    // The `default.md` convention: omitting `agent_type` looks for a role
    // literally named `default` (a `default.md` file, project layer first),
    // and only when neither layer defines one does the child run unmodified
    // on the parent's settings. An explicitly named role that exists nowhere
    // is the same outcome with a different story, and the description says
    // which one it was — "no such role" about a role nobody asked for would
    // read as an error about the request rather than the configuration.
    const omitted = name === undefined;
    return {
      role: {
        name: name ?? DEFAULT_ROLE_NAME,
        description: omitted
          ? "No default role configured; the child runs with the parent's own settings."
          : "No role of that name; the child runs with the parent's own settings.",
      },
      model: parent.model,
      allowedTools: parent.allowedTools,
      maxIterations: parent.maxIterations,
      withheld: [],
    };
  }

  const { tools, withheld } = toolsFor(parent.allowedTools, role);
  const wantedModel = role.model === undefined || role.model === "inherit" ? undefined : role.model;
  const wantedTurns = role.maxIterations;

  return {
    role,
    model: wantedModel ?? parent.model,
    allowedTools: tools,
    maxIterations:
      wantedTurns === undefined
        ? parent.maxIterations
        : parent.maxIterations === undefined
          ? wantedTurns
          : Math.min(wantedTurns, parent.maxIterations),
    withheld,
  };
}

/**
 * The role list as the model should see it.
 *
 * Codex does the same thing (`spec_plan.rs:753 agent_type_description`): when
 * there are no roles the description falls back to the default text, so a run
 * with no roles configured gets a byte-identical tool table.
 */
export function roleCatalogDescription(catalog: ReadonlyArray<SubagentRole>): string {
  if (catalog.length === 0) {
    return "";
  }
  const lines = catalog.map((role) => `- ${role.name}: ${role.description}`);
  return `Available agent types:\n${lines.join("\n")}`;
}

/**
 * A nickname for a spawned agent, unique among the agents already running.
 *
 * Uniqueness is not decoration. `send_input` and `wait_agent` take an id, but
 * the model reads these names, and two agents both called `scout` make
 * "ask scout" ambiguous at exactly the moment it matters. Candidates are tried
 * in the order the role lists them; when they run out the name is numbered
 * rather than repeated.
 */
export function uniqueNicknameFor(
  role: SubagentRole,
  agentId: string,
  taken: ReadonlySet<string>,
): string {
  const candidates = role.nicknameCandidates ?? [];
  if (candidates.length === 0) {
    return agentId;
  }
  for (const name of candidates) {
    if (!taken.has(name)) {
      return name;
    }
  }
  const base = candidates[0] as string;
  for (let suffix = 2; ; suffix += 1) {
    const numbered = `${base}-${suffix}`;
    if (!taken.has(numbered)) {
      return numbered;
    }
  }
}
