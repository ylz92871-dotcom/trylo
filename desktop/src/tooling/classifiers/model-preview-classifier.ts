import type { PackageRiskClassifier, ToolRiskContext, ToolRiskDecision } from '../tool-risk-classifier';
import { inputDigestOf } from '../input-digest';

export const MODEL_PREVIEW_TOOLS = ['preview_open', 'preview_view', 'preview_snapshot', 'preview_close'] as const;

/** Lexical preflight only; the service additionally checks real paths before reading. */
function insideWorkspace(input: string, root: string): boolean {
  if (!root || /[\u0000-\u001f]/.test(input) || /^[a-z]:[^/\\]/i.test(input)) return false;
  const normalize = (value: string): string => {
    const parts: string[] = [];
    for (const part of value.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  };
  const absolute = /^(?:[a-z]:[/\\]|[/\\])/i.test(input) ? input : `${root}/${input}`;
  const windows = /^[a-z]:|^[/\\]{2}/i.test(root);
  let base = normalize(root), target = normalize(absolute);
  if (windows) { base = base.toLowerCase(); target = target.toLowerCase(); }
  return base.length > 0 && target.startsWith(`${base}/`);
}

function classify(context: ToolRiskContext): ToolRiskDecision {
  const open = context.toolName.endsWith('__preview_open');
  const valid = !open || (typeof context.input.path === 'string' && insideWorkspace(context.input.path, context.projectRoot));
  const behavior = valid ? 'auto_allow' : 'deny';
  const reasonCode = valid ? 'model_preview_workspace_read' : 'model_preview_path_outside_workspace';
  const audit = {
    at: context.at, profileId: context.profileId, packageId: context.packageId,
    toolName: context.toolName, behavior, risk: 'read' as const, reasonCode,
    inputDigest: inputDigestOf(context.input), pathZones: open ? [{ field: 'path', zone: valid ? 'workspace' : 'outside' }] : [],
  };
  return valid
    ? { behavior: 'auto_allow', risk: 'read', reasonCode, audit: { ...audit, behavior: 'auto_allow' } }
    : { behavior: 'deny', reasonCode, userMessage: '3D 预览只能读取当前项目内的模型文件。', audit: { ...audit, behavior: 'deny' } };
}

/** Scene observation has no shell, arbitrary script, file write or desktop capture. */
export const modelPreviewClassifier: PackageRiskClassifier = {
  id: 'model-preview', serverName: 'trylo-preview',
  expectedTools: MODEL_PREVIEW_TOOLS.map(name => `mcp__trylo-preview__${name}`),
  classify,
};
