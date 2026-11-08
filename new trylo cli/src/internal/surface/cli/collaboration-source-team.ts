import path from "node:path";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { BoardState } from "../../learning/control/state.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import { isTeamLearningIssueReport } from "../../learning/control/coordination-contract.js";
import { coordinationForJob } from "../../learning/control/coordination-state.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { SubagentTeam } from "../../subagent/team.js";
import { teamProfileFor } from "./team-profile-wiring.js";

type SourceTeamResult = { readonly ok: true; readonly team?: SubagentTeam; readonly taskId?: string; readonly sourceIssueId?: string } | { readonly ok: false; readonly reason: string };

const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);

/** Independent learning reads one actual report's freeze, never a guessed or newly dispatched team. */
export async function readFocusedCollaborationTeam(input: { readonly board: Pick<BoardStore, "load">; readonly scope: string;
  readonly readFile: (absolutePath: string) => string | undefined; readonly skills?: SkillCatalogPort;
  readonly issueId?: string; readonly now?: () => number }): Promise<SourceTeamResult> {
  if (!path.isAbsolute(input.scope) || input.scope.includes("\0")) return { ok: false, reason: "source_team_scope_invalid" };
  try {
    const loaded = await input.board.load();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };

    const now = input.now ?? Date.now;
    const issue = input.issueId === undefined ? focusedIssue(loaded.state, input.scope, now())
      : loaded.state.learningIssues?.find(i => i.issueId === input.issueId && i.scope === input.scope && i.decision.kind === "focused_learning"
        && i.reports.some(isTeamLearningIssueReport));
    if (input.issueId !== undefined && issue === undefined) return { ok: false, reason: "source_issue_unavailable" };

    const teamReports = issue?.reports.filter(isTeamLearningIssueReport);
    const report = teamReports?.slice().reverse().find(r => r.source.memberId !== "personal_agent");
    if (report === undefined) {
      const personal = teamReports?.slice().reverse().find(r => r.source.memberId === "personal_agent");
      return { ok: true, ...(issue === undefined ? {} : { sourceIssueId: issue.issueId }), ...(personal === undefined ? {} : { taskId: personal.source.taskId }) };
    }

    const runId = report.source.teamRunId;
    if (!identifier(runId)) return { ok: false, reason: "source_team_run_invalid" };

    const teamRoot = path.resolve(input.scope, ".trylo", "team"), source = path.resolve(teamRoot, runId, "profile.v1.json");
    const relative = path.relative(teamRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "source_team_path_invalid" };

    const raw = input.readFile(source);
    if (raw === undefined) return { ok: false, reason: "source_team_unavailable" };

    if (raw.length > 2_000_000) return { ok: false, reason: "source_team_profile_invalid" };

    let frozen: unknown;
    try { frozen = JSON.parse(raw); }catch { return { ok: false, reason: "source_team_profile_invalid" }; }

    const roster = sourceRoster(frozen);
    if (roster === undefined || !roster.members.some(m => m.memberId === report.source.memberId)) return { ok: false, reason: "source_team_roster_invalid" };

    const systemPrompt = `<trylo_team_access>\ndecision: spawn_team\nteamRunId: ${runId}\n${roster.lines.join("\n")}\n</trylo_team_access>`;
    const resolved = teamProfileFor({ workspaceRoot: input.scope, systemPrompt,
      ...(input.skills === undefined ? {} : { skills: input.skills }), readFile: filename => path.resolve(filename) === source ? raw : undefined });
    if (!resolved.ok || resolved.team === undefined) return { ok: false, reason: "source_team_profile_unavailable" };

    // Names are encoded only in the synthesized parser block; the returned read model keeps the actual frozen labels.
    return { ok: true, ...(issue === undefined ? {} : { sourceIssueId: issue.issueId }), taskId: resolved.team.runId, team: { ...resolved.team, members: resolved.team.members.map(member => {
      const actual = roster.members.find(m => m.memberId === member.memberId)!;
      return { ...member, displayName: actual.displayName, role: { ...member.role, description: actual.displayName } };
    }) } };
  } catch { return { ok: false, reason: "source_team_unavailable" }; }
}

function focusedIssue(state: BoardState, scope: string, nowMs: number): LearningIssue | undefined {
  // Mirror central dispatch's read order only. The Board still claims/executes the job.
  const ready = state.jobs.filter(j => j.domain === "collaboration" && j.scope === scope && j.coordination !== undefined)
    .flatMap(j => {
      const value = coordinationForJob(state, j.jobId);
      return value === undefined ? [] : [value];
    })
    .filter(c => c.issue.decision.kind === "focused_learning" && c.grant.status === "open");
  const selected = ready.find(c => c.job.state === "running" && (c.grant.claim === undefined || Date.parse(c.grant.claim.expiresAt) <= nowMs))
    ?? ready.find(c => c.job.state === "queued");
  const focused = (state.learningIssues ?? []).filter(i => i.scope === scope && i.decision.kind === "focused_learning"
    && i.reports.some(isTeamLearningIssueReport));

  return selected?.issue ?? focused.find(i => i.grantId === undefined) ?? focused[0];
}

function sourceRoster(value: unknown): { members: readonly { memberId: string; displayName: string }[]; lines: string[] } | undefined {
  if (!row(value) || !row(value.frozenProfile) || !Array.isArray(value.frozenProfile.members)) return undefined;

  const profile = value.frozenProfile;
  if (profile.id !== undefined && (typeof profile.id !== "string" || !profile.id.trim() || profile.id.length > 512)
    || profile.surface !== undefined && profile.surface !== "code" && profile.surface !== "work") return undefined;

  const lines = [...(identifier(profile.id) ? [`profileId: ${profile.id}`] : []), ...(profile.surface === undefined ? [] : [`surface: ${profile.surface}`])];
  const members: { memberId: string; displayName: string }[] = [];

  for (const member of value.frozenProfile.members) {
    if (!row(member) || !identifier(member.memberId) || !identifier(member.baseRole) || typeof member.displayName !== "string" || member.displayName.length > 1000) return undefined;
    const label = JSON.stringify(member.displayName).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    members.push({ memberId: member.memberId, displayName: member.displayName });
    lines.push(`- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${label}`);
  }

  return { members, lines };
}
