import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ToolBinding } from "../../ports/tools.js";
import { resolveRole } from "../role.js";
import { narrowTeamTools, type SubagentTeamMember } from "../team.js";
import type { ExpertConfiguration, ExpertExperiencePort, ExpertIdentity, ExpertRequest,
  ExpertToolPort, ExpertToolResolution, ExpertVersion, ExpertUseScope } from "./contracts.js";
import { ExpertLibraryError } from "./contracts.js";
import { validateConfiguration } from "./validation.js";
import { EXPERT_EXPERIENCE_MAX_CHARS, normalizeExpertExperience } from "./experience.js";

export type ExpertMemberOverlay = { readonly model: string; readonly skills: readonly string[];
  readonly tools: readonly string[]; readonly disallowedTools: readonly string[]; readonly systemPromptOverlay: string };

export type ExpertInstantiation = {
  readonly runId: string;
  readonly surface: "code" | "work";
  readonly identity: ExpertIdentity;
  readonly member: SubagentTeamMember;
  /** Legacy frozen profiles cannot represent an expert-specific iteration ceiling. Use member in that case. */
  readonly overlay: ExpertMemberOverlay | undefined;
  readonly overlayUnavailableReason?: string;
  readonly toolResolutions: readonly ExpertToolResolution[];
  readonly withheldTools: readonly string[];
  readonly experienceVersionIds: readonly string[];
};

export type InstantiateExpertInput = {
  readonly expert: ExpertVersion | { readonly request: ExpertRequest };
  readonly memberId: string; readonly task: string; readonly runId: string; readonly surface: "code" | "work";
  readonly catalog: readonly ToolBinding[];
  readonly parent: { readonly model: string | undefined; readonly allowedTools: readonly string[];
    readonly maxIterations: number | undefined };
  readonly tools?: ExpertToolPort; readonly skills?: SkillCatalogPort; readonly experience?: ExpertExperiencePort;
  readonly useScope?: ExpertUseScope;
  readonly signal: AbortSignal;
};

/** Freeze a new working instance. No live member or long-term record is mutated. */
export async function instantiateExpert(input: InstantiateExpertInput): Promise<ExpertInstantiation> {
  checkCancelled(input.signal);
  const { identity, configuration } = configurationFor(input.expert, input.useScope);

  validateConfiguration(configuration);

  if (!input.memberId.trim() || !input.task.trim() || !input.runId.trim()) {
    throw new ExpertLibraryError("invalid_input", "Dispatch requires member, run and task identities");
  }

  if (input.surface !== "work" && configuration.baseRole.startsWith("cad-")) {
    throw new ExpertLibraryError("invalid_input", "CAD expert seats require the Work surface");
  }

  const resolutions = input.tools === undefined
    ? configuration.toolRefs.map(ref => ({ ref, state: "pending" as const, reason: "Tool library resolver is not connected" }))
    : await input.tools.resolve(configuration.toolRefs, input.signal);

  validateResolutions(configuration.toolRefs, resolutions);
  const selected = resolutions.flatMap(item => item.state === "resolved" ? [...item.toolNames] : []);
  const declared = configuration.role.allowedTools?.map(normalizeToolName);
  const requested = configuration.toolRefs.length === 0 ? declared
    : configuration.role.allowedTools === undefined ? selected
      : selected.filter(name => declared!.includes(name));
  const loaded = loadSkills(configuration, input.skills);
  const basePrompt = renderProfessionalPrompt(configuration, identity, "");

  // Professional configuration takes priority. The collaboration owner receives
  // the exact remaining budget and must select shorter guidance, never truncation.
  if (basePrompt.length > 2000) throw new ExpertLibraryError("invalid_input", "Expert dispatch instructions exceed the 2000-character team overlay limit; shorten methods or instructions");

  const experienceBudget = Math.max(0, Math.min(EXPERT_EXPERIENCE_MAX_CHARS,
    2000 - basePrompt.length - EXPERIENCE_LABEL.length - 2));
  const experienceResult = input.experience === undefined || experienceBudget === 0 ? "" : await input.experience.load({ ...identity,
    task: input.task, maxChars: experienceBudget, signal: input.signal });

  checkCancelled(input.signal);
  const guidance = normalizeExpertExperience(experienceResult, experienceBudget);
  const experience = guidance.text.trim().length > 0 ? guidance.text : "";
  const experienceVersionIds = experience ? guidance.versionIds : [];
  const professionalPrompt = renderProfessionalPrompt(configuration, identity, experience);
  let allowed: readonly string[] | undefined = requested;

  for (const restriction of loaded.restrictions) {
    allowed = allowed === undefined ? restriction : allowed.filter(name => restriction.includes(name));
  }

  const role = { ...configuration.role, name: configuration.baseRole,
    prompt: [professionalPrompt, ...loaded.instructions].join("\n\n"),
    disallowedTools: configuration.role.disallowedTools?.map(normalizeToolName),
    ...(allowed === undefined ? {} : { allowedTools: allowed }) };
  const member: SubagentTeamMember = { memberId: input.memberId, baseRole: configuration.baseRole,
    displayName: configuration.displayName, role };
  const narrowed = narrowTeamTools({ runId: input.runId, surface: input.surface, members: [member] }, input.catalog).members[0]!;
  const resolved = resolveRole([narrowed.role], configuration.baseRole, input.parent);
  const names = [...resolved.allowedTools];
  const effective = { ...narrowed, role: { ...narrowed.role, model: resolved.model ?? "inherit",
    allowedTools: names, maxIterations: resolved.maxIterations } };
  const attempted = requested ?? [];

  return { runId: input.runId, surface: input.surface, identity, member: effective,
    overlay: configuration.role.maxIterations === undefined ? { model: resolved.model ?? "inherit", skills: [...(configuration.role.skills ?? [])], tools: names,
      disallowedTools: [...(configuration.role.disallowedTools ?? [])], systemPromptOverlay: professionalPrompt } : undefined,
    ...(configuration.role.maxIterations === undefined ? {} : { overlayUnavailableReason: "The legacy frozen profile cannot preserve this expert's iteration ceiling; dispatch the returned member configuration" }),
    toolResolutions: resolutions.map(item => item.state !== "resolved" ? item :
      item.toolNames.some(name => names.includes(name)) ? { ...item, toolNames: item.toolNames.filter(name => names.includes(name)) }
        : { ref: item.ref, state: "unavailable", reason: "Selected tools are withheld by the member role, installed skill, catalog or parent allowance" }),
    withheldTools: [...new Set([...attempted.filter(name => !names.includes(name)), ...resolved.withheld])], experienceVersionIds };
}

function configurationFor(expert: InstantiateExpertInput["expert"], useScope: ExpertUseScope | undefined): { readonly identity: ExpertIdentity; readonly configuration: ExpertConfiguration } {
  if (!("request" in expert)) return { identity: { expertId: expert.expertId, version: expert.version,
    experienceKey: expert.experienceKey }, configuration: expert.configuration };

  const request = expert.request;
  if (!request.creationAuthorization || !request.configuration || !["awaiting_retention", "temporary"].includes(request.state)) {
    throw new ExpertLibraryError("unauthorized", "Temporary use requires an authorized, completed expert configuration");
  }

  if (request.useScope === undefined || useScope === undefined || request.useScope.workspaceId !== useScope.workspaceId
    || request.useScope.taskId !== useScope.taskId) {
    throw new ExpertLibraryError("unauthorized", "Temporary expert use is restricted to its authorized workspace and task scope");
  }

  return { identity: { expertId: request.expertId, version: request.baseVersion + 1, experienceKey: request.experienceKey,
    draft: { requestId: request.requestId, revision: request.revision } },
    configuration: request.configuration };
}

function loadSkills(configuration: ExpertConfiguration, catalog: SkillCatalogPort | undefined): {
  readonly instructions: string[]; readonly restrictions: (readonly string[])[] } {
  const names = configuration.role.skills ?? [];
  if (names.length > 0 && configuration.baseRole !== "worker") {
    throw new ExpertLibraryError("resource_unavailable", "The existing team runtime preloads skills only for worker seats");
  }

  const instructions: string[] = [];
  const restrictions: (readonly string[])[] = [];

  for (const name of names) {
    const loaded = catalog?.load(name, undefined);
    if (loaded === undefined || loaded.kind !== "loaded") throw new ExpertLibraryError("resource_unavailable", `Selected expert skill '${name}' is not installed`);
    if (loaded.skill.descriptor.forkExecution) throw new ExpertLibraryError("resource_unavailable", `Selected expert skill '${name}' requires a nested fork`);
    instructions.push(`Selected member skill: ${name}\n${loaded.skill.content}`);
    if (loaded.skill.descriptor.allowedTools !== undefined) restrictions.push(loaded.skill.descriptor.allowedTools.map(normalizeToolName));
  }

  return { instructions, restrictions };
}

const TOOL_ALIASES: Readonly<Record<string, string>> = { Read: "read_file", Write: "write_file", Edit: "edit_file",
  Bash: "run_shell", PowerShell: "run_shell", Grep: "search_text", Glob: "glob_files", LSP: "lsp_navigate",
  WebSearch: "web_search", WebFetch: "web_fetch", NotebookEdit: "notebook_edit", TodoWrite: "todo_write", Skill: "skill" };

function normalizeToolName(name: string): string { return TOOL_ALIASES[name] ?? name; }

const EXPERIENCE_LABEL = "Task-relevant collaboration experience for this expert only:\n";

function renderProfessionalPrompt(configuration: ExpertConfiguration, identity: ExpertIdentity, experience: string): string {
  return [`Expert ${identity.expertId} v${identity.version}: ${configuration.specialty}`,
    `Applicable situations: ${configuration.situations.join("; ")}`,
    `Responsibilities: ${configuration.responsibilities.join("; ")}`,
    `User constraints (authoritative): ${configuration.constraints.join("; ")}`,
    `Collaboration: ${configuration.collaboration.join("; ")}`,
    configuration.role.prompt ?? "",
    ...configuration.methods.map(method => `Method ${method.title}: ${method.instructions}\nSources: ${method.sourceUris.join(", ")}`),
    experience ? `${EXPERIENCE_LABEL}${experience}` : ""].filter(Boolean).join("\n\n");
}

function validateResolutions(refs: readonly string[], resolutions: readonly ExpertToolResolution[]): void {
  if (!Array.isArray(resolutions) || resolutions.length !== refs.length || new Set(resolutions.map(item => item.ref)).size !== refs.length
    || resolutions.some(item => !refs.includes(item.ref) || !["resolved", "pending", "unavailable"].includes(item.state)
      || (item.state === "resolved" && (!Array.isArray(item.toolNames) || item.toolNames.some((name: unknown) => typeof name !== "string" || !name.trim()))))) {
    throw new ExpertLibraryError("invalid_input", "Tool resolver must return exactly one result for each expert reference");
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExpertLibraryError("cancelled", "Expert dispatch was cancelled");
}
