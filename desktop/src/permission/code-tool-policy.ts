import type { PermissionLevel } from './permission-policy';
import type { ToolRiskDecision, ToolRiskRoute, SafeAudit } from '../tooling/tool-risk-classifier';
import { inputDigestOf } from '../tooling/input-digest';
import { safeRelativePath } from '../approval/approval-preview';
import type { FilePath } from '../host-adapter/types';

interface PolicyInput {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permissionLevel: PermissionLevel;
  readonly projectRoot: string;
  readonly profileId?: string;
  readonly at: number;
}

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['read_file', 'list_files', 'search_text', 'Read', 'Glob', 'Grep', 'LS']);

/** Lexical eligibility only; CLI sandbox admission still validates actual filesystem paths. */
function workspaceTarget(raw: unknown, root: string): boolean {
  if (typeof raw !== 'string' || !raw || !root) return false;
  let target = raw.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^(?:[a-zA-Z]:|\/)/.test(target)) {
    const windows = /^[a-zA-Z]:/.test(base);
    const prefix = `${base}/`;
    if (!(windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix))) return false;
    target = target.slice(prefix.length);
  }
  return Boolean(safeRelativePath(target, root as FilePath)) && !Array.from(target).some(char => char.charCodeAt(0) < 32);
}

/** Classify patch authority, not patch execution. Unknown syntax stays a human decision. */
function editablePatch(input: PolicyInput): boolean {
  const patch = input.input['patch'];
  if (typeof patch !== 'string') return false;
  const lines = patch.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return false;
  const headers = lines.filter(line => line.startsWith('*** ') && line !== '*** Begin Patch' && line !== '*** End Patch');
  return headers.length > 0 && headers.every(line => {
    const target = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line)?.[1];
    return workspaceTarget(target, input.projectRoot);
  });
}

/** Final host decision for every approval-capable tool. Package denials remain authoritative. */
export function resolveCodeToolPolicy(input: PolicyInput, classified: ToolRiskRoute): ToolRiskDecision {
  if (classified.behavior === 'deny') return classified;
  const audit: SafeAudit = classified.behavior === 'unmanaged' ? {
    at: input.at, profileId: input.profileId ?? '', packageId: 'host-policy', toolName: input.toolName,
    behavior: 'prompt', risk: null, reasonCode: 'unclassified_tool', inputDigest: inputDigestOf(input.input), pathZones: [],
  } : classified.audit;
  const allow = (risk: 'read' | 'workspace-write', reasonCode: string): ToolRiskDecision => ({
    behavior: 'auto_allow', risk, reasonCode, audit: { ...audit, behavior: 'auto_allow', risk, reasonCode },
  });
  const deny = (reasonCode: string, userMessage: string): ToolRiskDecision => ({
    behavior: 'deny', reasonCode, userMessage, audit: { ...audit, behavior: 'deny', risk: null, reasonCode },
  });
  const prompt = (reasonCode: string): ToolRiskDecision => ({
    behavior: 'prompt', risk: 'sensitive', reasonCode,
    preview: { kind: 'summary', title: input.toolName, reason: '当前权限模式要求确认本次操作。' },
    audit: { ...audit, behavior: 'prompt', risk: 'sensitive', reasonCode },
  });
  if (FILE_TOOLS.has(input.toolName) && !workspaceTarget(input.input['path'] ?? input.input['file_path'] ?? input.input['notebook_path'], input.projectRoot)) {
    return deny('path_outside_workspace', 'Denied: the file target is missing, invalid or outside the workspace.');
  }
  if (input.permissionLevel === 'unrestricted') return allow('workspace-write', 'unrestricted');
  if (input.permissionLevel === 'read_only' && classified.behavior !== 'unmanaged'
    && !(classified.behavior === 'auto_allow' && classified.risk === 'read')) {
    return deny('read_only', 'Denied: this conversation is read-only.');
  }
  if (classified.behavior !== 'unmanaged') {
    if (input.permissionLevel === 'ask' && classified.behavior === 'auto_allow' && classified.risk === 'workspace-write') {
      return prompt('ask_level_write');
    }
    return classified;
  }
  if (READ_TOOLS.has(input.toolName)) return allow('read', 'read_tool');
  if (input.permissionLevel === 'read_only') return deny('read_only', 'Denied: this conversation is read-only; unclassified effects are unavailable.');
  if (input.permissionLevel === 'workspace_write' && (FILE_TOOLS.has(input.toolName)
    || (input.toolName === 'apply_patch' && editablePatch(input)))) return allow('workspace-write', 'workspace_edit');
  return prompt('tool_requires_approval');
}
