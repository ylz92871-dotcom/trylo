import path from "node:path";
import type { SubagentTeam, SubagentTeamMember } from "../../subagent/team.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import { inspectTeamRepresentation } from "../../protocol/team-representation.js";
import { constrainWorkMemberTool } from "./team-work-policy.js";
import { TEAM_MEMBER_GUIDANCE } from "./team-member-guidance.js";

const CAD_ROLES = ["cad-planner", "cad-verifier"];
const ROLES = ["person", "architect", "worker", "reviewer", "verifier", ...CAD_ROLES];
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Read: "read_file", Write: "write_file", Edit: "edit_file", Bash: "run_shell", PowerShell: "run_shell",
  Grep: "search_text", Glob: "glob_files", LSP: "lsp_navigate", WebSearch: "web_search", WebFetch: "web_fetch",
  NotebookEdit: "notebook_edit", TodoWrite: "todo_write", Skill: "skill",
};
type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);

export type TeamProfileWiring = { readonly ok: true; readonly team?: SubagentTeam; readonly protocol?: string }
  | { readonly ok: false; readonly message: string };

/** Read the same freeze the composer wrote; ordinary turns perform no team IO. */
export function teamProfileFor(input: { readonly workspaceRoot: string; readonly systemPrompt?: string;
  readonly skills?: SkillCatalogPort;
  readonly readFile: (path: string) => string | undefined }): TeamProfileWiring {
  const prompt = input.systemPrompt ?? "";
  const blocks = [...prompt.matchAll(/<trylo_team_access>([\s\S]*?)<\/trylo_team_access>/g)]
    .map(match => match[1] ?? "").filter(block => /^decision:\s*spawn_team\s*$/m.test(block));
  if (blocks.length === 0) return { ok: true };
  if (blocks.length !== 1) return { ok: false, message: "Team configuration is ambiguous: multiple frozen teams were supplied" };
  const block = blocks[0]!;
  const announcedSurface = /^surface:\s*(\S+)\s*$/m.exec(block)?.[1];
  if (announcedSurface !== undefined && announcedSurface !== "code" && announcedSurface !== "work") {
    return { ok: false, message: "The frozen team surface is invalid" };
  }
  let surface: "code" | "work" = announcedSurface ?? "code";
  const runId = /^teamRunId:\s*(\S+)\s*$/m.exec(block)?.[1];
  if (!identifier(runId)) return { ok: false, message: "Team run id is missing or invalid" };
  const roster = [...block.matchAll(/^- member_id=(\S+) baseRole=(\S+) displayName=([^\r\n]*)/gm)]
    .map(match => ({ memberId: match[1]!, baseRole: match[2]!, displayName: match[3]! }));
  if (roster.length < 2 || roster.length > 16 || new Set(roster.map(member => member.memberId)).size !== roster.length
    || roster.some(member => !identifier(member.memberId) || !ROLES.includes(member.baseRole))) {
    return { ok: false, message: "The frozen team roster is missing, duplicated or invalid" };
  }
  let frozen: unknown;
  const raw = input.readFile(path.join(input.workspaceRoot, ".trylo", "team", runId, "profile.v1.json"));
  if (raw !== undefined) {
    try { frozen = JSON.parse(raw); }
    catch { return { ok: false, message: "The frozen team profile is unreadable JSON" }; }
    if (!record(frozen) || !record(frozen.frozenProfile) || !Array.isArray(frozen.frozenProfile.members)) {
      return { ok: false, message: "The frozen team profile has an invalid shape" };
    }
    const frozenSurface = frozen.frozenProfile.surface;
    if (frozenSurface !== undefined) {
      if ((frozenSurface !== "code" && frozenSurface !== "work") || (announcedSurface !== undefined && announcedSurface !== frozenSurface)) {
        return { ok: false, message: "The frozen profile surface does not match the announced team" };
      }
      surface = frozenSurface;
    }
    frozen = frozen.frozenProfile.members;
  }
  if (surface !== "work" && roster.some(member => CAD_ROLES.includes(member.baseRole))) {
    return { ok: false, message: "CAD planning and verification members require the Work surface" };
  }
  const members: SubagentTeamMember[] = [];
  const contract = /<trylo_engineering_contract>[\s\S]*?<\/trylo_engineering_contract>/.exec(block)?.[0] ?? "";
  for (const member of roster) {
    const row = Array.isArray(frozen) ? frozen.find((candidate: unknown) => record(candidate) && candidate.memberId === member.memberId) : undefined;
    if (raw !== undefined && (!record(row) || row.baseRole !== member.baseRole)) {
      return { ok: false, message: "The frozen profile does not match the announced roster" };
    }
    let overlay: unknown = record(row) ? row.overlay : undefined;
    if (raw === undefined) {
      const tag = [...prompt.matchAll(/<trylo_member_overlay member_id="([^"]+)">([\s\S]*?)<\/trylo_member_overlay>/g)]
        .find(match => match[1] === member.memberId);
      if (!tag) return { ok: false, message: "The frozen profile is missing and no member fallback was supplied" };
      try { overlay = JSON.parse(tag[2]!); }
      catch { return { ok: false, message: "A member fallback is unreadable JSON" }; }
    }
    if (!record(overlay) || typeof overlay.model !== "string" || typeof overlay.systemPromptOverlay !== "string"
      || !strings(overlay.skills) || (overlay.tools !== undefined && !strings(overlay.tools))
      || (overlay.disallowedTools !== undefined && !strings(overlay.disallowedTools))) {
      return { ok: false, message: "A frozen member overlay is invalid" };
    }
    const translation = new RegExp(`<trylo_team_translation audience="seat:${member.baseRole}">([\\s\\S]*?)<\\/trylo_team_translation>`).exec(block)?.[1] ?? "";
    const normalizeTools = (names: string[]): string[] => [...new Set(names.map(name => TOOL_ALIASES[name] ?? name))];
    const skills = member.baseRole === "worker" ? [...new Set(overlay.skills)] : [];
    const instructions: string[] = [];
    let allowedTools = strings(overlay.tools) ? normalizeTools(overlay.tools) : undefined;
    for (const name of skills) {
      const loaded = input.skills?.load(name, undefined);
      if (loaded === undefined || loaded.kind === "unknown_skill") {
        return { ok: false, message: `Selected team skill '${name}' is not installed` };
      }
      if (loaded.skill.descriptor.forkExecution) {
        return { ok: false, message: `Selected team skill '${name}' requires a nested fork, which frozen members cannot spawn` };
      }
      instructions.push(`Selected member skill: ${name}\n${loaded.skill.content}`);
      const requestedTools = loaded.skill.descriptor.allowedTools;
      if (requestedTools !== undefined) {
        const skillTools = normalizeTools([...requestedTools]);
        allowedTools = allowedTools === undefined ? skillTools : allowedTools.filter(tool => skillTools.includes(tool));
      }
    }
    members.push({ ...member, role: { name: member.baseRole, description: member.displayName,
      model: overlay.model, prompt: [TEAM_MEMBER_GUIDANCE[member.baseRole],
        surface === "work" ? "Work deliverables must be written under .trylo/out. Preserve source documents. Report the actual output path and request parent-owned actions for unavailable tools; never bypass the role floor with shell or another mutation channel." : "",
        contract, translation,
        overlay.systemPromptOverlay.slice(0, 2000), ...instructions].filter(Boolean).join("\n\n"),
      skills,
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(strings(overlay.disallowedTools) ? { disallowedTools: normalizeTools(overlay.disallowedTools) } : {}) } });
  }
  return { ok: true, team: { runId, members, surface,
    ...(surface === "work" ? { constrainTool: (memberId, call) => {
      const member = members.find(candidate => candidate.memberId === memberId);
      return member ? constrainWorkMemberTool(member.baseRole, input.workspaceRoot, call)
        : { ok: false, code: "team_member_unavailable", message: "The member is absent from the frozen Work roster" };
    } } : {}),
    ...(members.some(member => member.baseRole === "person") ? { inspectRepresentation: inspectTeamRepresentation } : {}),
    ...(/^TRYLO_TEAM_HOLD:\s*worker\s*$/m.test(block) ? { heldRoles: ["worker"] } : {}) },
    protocol: "Team runtime: dispatch each frozen member with spawn_agent(message, agent_type, member_id). Collect Person's complete representation before dispatching a Worker. Person must use ### Intent / ### Veto / ### User questions / ### Representation notes; nonblocking Veto and User questions sections must each contain exactly none (no period or explanation). If format drifts, ask Person to correct the format while preserving every real blocker. Vetoes and open questions require clarification before Person can clear implementation. Never redirect a Worker's implementation assignment to Person: Person is read-only. Use send_input for follow-ups, wait_agent to collect actual results (release_on_ready frees execution slots; after suppresses repeated answers), and close_agent after the member finishes. Agent/subagent_type is legacy syntax and is unavailable here. Do not dispatch members outside the frozen roster." };
}
