import { describe, expect, it } from 'vitest';
import { resolveCodeToolPolicy } from './code-tool-policy';
import type { ToolRiskRoute } from '../tooling/tool-risk-classifier';

const input = { toolName: 'mcp__fixture__write', input: {}, permissionLevel: 'read_only' as const,
  projectRoot: 'D:/project', at: 1 };
const audit = { at: 1, profileId: 'fixture', packageId: 'fixture', toolName: input.toolName,
  behavior: 'prompt' as const, risk: 'external' as const, reasonCode: 'external_effect', inputDigest: 'fixture', pathZones: [] };

describe('final Code tool policy shared by both CLI runtimes', () => {
  it('approval previews identify external targets and exact shell commands without file contents', () => {
    const file = resolveCodeToolPolicy({ ...input, permissionLevel: 'ask', toolName: 'write_file',
      input: { path: 'D:/outside/report.txt', content: 'private proposed content' } }, { behavior: 'unmanaged' });
    expect(file).toMatchObject({ behavior: 'prompt', preview: { target: 'D:/outside/report.txt' } });
    expect(JSON.stringify(file)).not.toContain('private proposed content');
    const command = "$v = 'hello'; Set-Content report.txt $v";
    expect(resolveCodeToolPolicy({ ...input, permissionLevel: 'ask', toolName: 'run_shell', input: { command, cwd: 'D:/outside' } },
      { behavior: 'unmanaged' })).toMatchObject({ behavior: 'prompt', preview: { kind: 'command', command, cwd: 'D:/outside' } });
    expect(resolveCodeToolPolicy({ ...input, permissionLevel: 'ask', toolName: 'read_file', input: { path: 'D:/outside/image.png' } },
      { behavior: 'unmanaged' })).toMatchObject({ behavior: 'prompt', preview: { target: 'D:/outside/image.png' } });
  });
  it('a managed read classification cannot auto-approve a V1 external-path request', () => {
    const classified: ToolRiskRoute = { behavior: 'auto_allow', risk: 'read', reasonCode: 'read',
      audit: { ...audit, behavior: 'auto_allow', risk: 'read' } };
    for (const permissionLevel of ['ask', 'workspace_write', 'read_only'] as const) {
      expect(resolveCodeToolPolicy({ ...input, toolName: 'read_file', input: { path: 'D:/outside.txt' }, permissionLevel }, classified))
        .toMatchObject({ behavior: permissionLevel === 'read_only' ? 'deny' : 'prompt' });
    }
  });
  it('external file writes reach explicit review and unrestricted follows the selected authority', () => {
    for (const permissionLevel of ['ask', 'workspace_write', 'unrestricted'] as const) {
      expect(resolveCodeToolPolicy({ ...input, toolName: 'write_file', input: { path: 'D:/other/report.txt' }, permissionLevel },
        { behavior: 'unmanaged' })).toMatchObject({ behavior: permissionLevel === 'unrestricted' ? 'auto_allow' : 'prompt' });
    }
    expect(resolveCodeToolPolicy({ ...input, toolName: 'write_file', input: { path: 'D:/other/report.txt' } },
      { behavior: 'unmanaged' })).toMatchObject({ behavior: 'deny' });
  });
  it('read-only denies managed effects instead of offering an approval that expands the mode', () => {
    const classified: ToolRiskRoute = { behavior: 'prompt', risk: 'external', reasonCode: 'external_effect',
      preview: { kind: 'summary', title: 'Write', reason: 'external effect' }, audit };
    expect(resolveCodeToolPolicy(input, classified)).toMatchObject({ behavior: 'deny', reasonCode: 'read_only' });
  });

  it('read-only retains verified managed reads', () => {
    const classified: ToolRiskRoute = { behavior: 'auto_allow', risk: 'read', reasonCode: 'read',
      audit: { ...audit, behavior: 'auto_allow', risk: 'read' } };
    expect(resolveCodeToolPolicy(input, classified)).toEqual(classified);
  });

  it('all modes retain package denials', () => {
    const classified: ToolRiskRoute = { behavior: 'deny', reasonCode: 'package_disabled', userMessage: 'Disabled',
      audit: { ...audit, behavior: 'deny', risk: null } };
    for (const permissionLevel of ['read_only', 'ask', 'workspace_write', 'unrestricted'] as const) {
      expect(resolveCodeToolPolicy({ ...input, permissionLevel }, classified)).toEqual(classified);
    }
  });
});
