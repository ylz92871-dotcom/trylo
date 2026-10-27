import type { SandboxVerdict, ToolBinding, ToolCallRequest } from "../ports/tools.js";
import { SubagentGovernanceError } from "./governance.js";
import type { SubagentRole } from "./role.js";
import type { TeamRepresentationVerdict } from "../protocol/team-representation.js";

export type TeamMemberIdentity = { readonly teamRunId: string; readonly memberId: string };
export type SubagentTeamMember = {
  readonly memberId: string;
  readonly baseRole: string;
  readonly displayName: string;
  readonly role: SubagentRole;
};
export type SubagentTeam = {
  readonly surface?: "code" | "work";
  readonly constrainTool?: (memberId: string, call: ToolCallRequest) => SandboxVerdict;
  readonly inspectRepresentation?: (output: string) => TeamRepresentationVerdict;
  readonly runId: string;
  readonly members: ReadonlyArray<SubagentTeamMember>;
  readonly heldRoles?: ReadonlyArray<string>;
};

const INSPECTION_TOOLS = ["read_file", "list_files", "search_text", "glob_files", "find_files",
  "lsp_navigate", "view_image", "read_pdf", "read_notebook"];
const IMPLEMENTATION_TOOLS = ["write_file", "edit_file", "apply_patch", "notebook_edit", "run_shell",
  "write_stdin", "list_processes", "stop_process", "todo_write"];
const WORK_IMPLEMENTATION_TOOLS = ["write_file", "edit_file", "todo_write"];
const RESEARCH_TOOLS = ["web_fetch", "web_search"];

function memberTools(member: SubagentTeamMember, catalog: ReadonlyArray<ToolBinding>, surface: SubagentTeam["surface"]): string[] {
  const allowed = new Set(INSPECTION_TOOLS);
  if (member.baseRole === "worker") {
    for (const name of surface === "work" ? WORK_IMPLEMENTATION_TOOLS : IMPLEMENTATION_TOOLS) allowed.add(name);
    // Selected skills are preloaded by team profile wiring. A shared skill
    // tool would expose unselected skills and a second anonymous fork path.
    // Research is an explicit worker overlay extra, not an implicit grant.
    if (member.role.allowedTools !== undefined) for (const name of RESEARCH_TOOLS) allowed.add(name);
  } else if (member.baseRole === "architect") {
    for (const name of RESEARCH_TOOLS) allowed.add(name);
  } else if (surface === "work" && (member.baseRole === "cad-planner" || member.baseRole === "cad-verifier")) {
    // These seats author documents, never geometry or executor evidence.
    allowed.add("write_file");
    allowed.add("edit_file");
  }
  // A read-only seat cannot safely borrow the general shell. It needs a
  // separately enforced inspection-only command port before that floor can grow.
  const floor = catalog.filter(tool => allowed.has(tool.name)).map(tool => tool.name);
  return member.role.allowedTools === undefined ? floor : member.role.allowedTools.filter(name => floor.includes(name));
}

/** Frozen role policy may only subtract from the parent's dispatch allowance. */
export function narrowTeamTools(team: SubagentTeam, catalog: ReadonlyArray<ToolBinding>): SubagentTeam {
  return { ...team, members: team.members.map(member => ({ ...member, role: { ...member.role,
    allowedTools: memberTools(member, catalog, team.surface) } })) };
}

/** An explicit identity is never downgraded to a same-role FIFO match. */
export function selectTeamMember(team: SubagentTeam | undefined, role: string | undefined,
  memberId: string | undefined, occupied: ReadonlySet<string>): SubagentTeamMember | undefined {
  if (team === undefined) {
    if (memberId !== undefined) throw new SubagentGovernanceError("team_unavailable", "No frozen team is attached to this turn");
    return undefined;
  }
  const member = memberId === undefined
    ? team.members.find(candidate => candidate.baseRole === role && !occupied.has(candidate.memberId))
    : team.members.find(candidate => candidate.memberId === memberId && (role === undefined || candidate.baseRole === role));
  if (member === undefined) {
    throw new SubagentGovernanceError("team_member_unavailable", "The member is absent, has a different role, or is already assigned; use send_input for existing members");
  }
  if (occupied.has(member.memberId)) throw new SubagentGovernanceError("team_member_busy", "This frozen member already has a task; use send_input or resume_agent");
  if (team.heldRoles?.includes(member.baseRole)) throw new SubagentGovernanceError("team_role_held", "This role is held pending clarification");
  return member;
}
