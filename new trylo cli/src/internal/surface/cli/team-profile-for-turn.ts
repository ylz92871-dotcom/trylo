import { createHermesExplicitResolver, createTeamSkillProvisionObserver, SKILL_AUTHORITY_GUIDANCE } from "../../learning/agent/subsystems/skill/host/index.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ChildRequestObservation } from "../../subagent/request-dispatched.js";
import type { CliContext } from "./context.js";
import { createCliHermesClient, hermesCapabilitiesDirectory } from "./hermes-skill-client.js";
import type { RunScaffold } from "./run-command.js";
import { bindTeamProfile, prepareTeamProfile, type TeamProfileWiring } from "./team-profile-wiring.js";

type ResolveSelected = ReturnType<typeof createHermesExplicitResolver>["resolveSelected"];

type TeamTurnContext = Pick<CliContext, "readFile" | "env" | "homeDir" | "nodeExecutable" | "newId" | "stderr">;

type TeamTurnScaffold = Pick<RunScaffold, "workspaceRoot" | "systemPrompt" | "systemPromptAppend" | "learning">;

type TeamTurnProfile = Extract<TeamProfileWiring, { readonly ok: false }>
  | Extract<TeamProfileWiring, { readonly ok: true }> & { readonly onChildRequestDispatched?: ChildRequestObservation };

/** Freeze once; await native reads only for explicitly selected, locally missing skills. */
export async function teamProfileForTurn(ctx: TeamTurnContext, scaffold: TeamTurnScaffold, localCatalog?: SkillCatalogPort,
  signal?: AbortSignal, resolveSelected?: ResolveSelected): Promise<TeamTurnProfile> {
  const prepared = prepareTeamProfile({ workspaceRoot: scaffold.workspaceRoot, readFile: ctx.readFile,
    ...(scaffold.systemPrompt === undefined ? {} : { systemPrompt: scaffold.systemPrompt.text }),
    ...(scaffold.systemPromptAppend === undefined ? {} : { systemPromptAppend: scaffold.systemPromptAppend }) });
  if (!prepared.ok) return prepared;

  const names = [...new Set(prepared.prepared?.selectedWorkerSkills.flatMap(item => item.names) ?? [])]
    .filter(name => localCatalog?.load(name, undefined).kind !== "loaded");
  const learning = scaffold.learning;
  if (names.length === 0 || learning !== "skill" && learning !== "all") return bindTeamProfile(prepared.prepared, localCatalog);

  const resolve: ResolveSelected = resolveSelected ?? (async input => {
    const client = createCliHermesClient(ctx);
    try {
      const profile = await client.profile("normal", input.signal);
      return await createHermesExplicitResolver({ pythonBinary: profile.command, capabilitiesDir: hermesCapabilitiesDirectory,
        hermesHome: profile.env.HERMES_HOME!, env: ctx.env }).resolveSelected(input);
    } finally {
      client.close();
    }
  });

  try {
    const result = await resolve({ names, ...(localCatalog === undefined ? {} : { localCatalog }),
      ...(signal === undefined ? {} : { signal }) });
    if (!result.ok) return { ok: false as const, message: `Selected team skill could not be loaded (${result.code}).` };

    // The overlay is lent only to this binding. Parent builtin skills stay on their original catalog.
    const bound = bindTeamProfile(prepared.prepared, result.catalog);
    if (!bound.ok || bound.team === undefined || prepared.prepared === undefined) return bound;

    const nativeNames = new Set(result.provided.map(item => item.requestedName));
    const nativeMembers = new Set(prepared.prepared.selectedWorkerSkills
      .filter(member => member.names.some(name => nativeNames.has(name))).map(member => member.memberId));
    const team = { ...bound.team, members: bound.team.members.map(member => nativeMembers.has(member.memberId)
      ? { ...member, role: { ...member.role, prompt: [member.role.prompt, SKILL_AUTHORITY_GUIDANCE].filter(Boolean).join("\n\n") } }
      : member) };
    const onChildRequestDispatched = createTeamSkillProvisionObserver({ teamRunId: bound.team.runId,
      members: prepared.prepared.selectedWorkerSkills, catalog: result.catalog, resolved: result.provided,
      warn: code => ctx.stderr(`warning: ${code}\n`) });

    return { ...bound, team, ...(onChildRequestDispatched === undefined ? {} : { onChildRequestDispatched }) };
  } catch {
    return { ok: false as const, message: signal?.aborted ? "Selected team skill loading was cancelled."
      : "Selected team skill could not be loaded (hermes_explicit_unavailable)." };
  }
}
