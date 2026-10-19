import { describe, expect, it } from 'vitest';
import { resolveCodeToolPolicy } from './code-tool-policy';
import type { ToolRiskRoute } from '../tooling/tool-risk-classifier';

const input = { toolName: 'mcp__fixture__write', input: {}, permissionLevel: 'read_only' as const,
  projectRoot: 'D:/project', at: 1 };
const audit = { at: 1, profileId: 'fixture', packageId: 'fixture', toolName: input.toolName,
  behavior: 'prompt' as const, risk: 'external' as const, reasonCode: 'external_effect', inputDigest: 'fixture', pathZones: [] };

describe('final Code tool policy shared by both CLI runtimes', () => {
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
