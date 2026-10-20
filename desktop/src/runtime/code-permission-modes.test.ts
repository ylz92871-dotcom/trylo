// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CodePermissionRegistry } from './code-permission-registry';
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier';
import type { PermissionLevel } from '../permission/permission-policy';

function setup(level: PermissionLevel, send: (id: string, line: string) => Promise<boolean> = vi.fn(async () => true)) {
  const registry = new CodePermissionRegistry({ onChange() {}, riskClassifier: createToolRiskClassifier(), send });
  const scope = { processId: 'p', projectKey: 'project', conversationId: 'c', projectRoot: 'D:/work/project',
    permissionLevel: level, profileId: 'code.core.v1', managedPackageIds: ['playwright', 'kicad-mcp'] };
  return { registry, send, issue(toolName: string, input: Record<string, unknown>) {
    registry.handleControlFrame({ kind: 'permission', requestId: 'r', toolName, input }, scope);
  } };
}

it.each(['read_only', 'ask', 'workspace_write', 'unrestricted'] as const)('%s enforces file writes at the host boundary', async level => {
  const h = setup(level); h.issue('write_file', { path: 'result.txt', content: 'proof' });
  await vi.waitFor(() => {
    expect(h.registry.list()).toHaveLength(level === 'ask' ? 1 : 0);
    if (level !== 'ask') expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining(`"behavior":"${level === 'read_only' ? 'deny' : 'allow'}"`));
  });
});

it('fully automatic includes browser scripts and user-mounted MCP tools', async () => {
  for (const [tool, input] of [
    ['mcp__trylo-browser__browser_evaluate', { function: '() => 1' }],
    ['mcp__custom__publish', { payload: 'synthetic' }],
    ['web_fetch', { url: 'https://example.com' }],
  ] as const) {
    const h = setup('unrestricted'); h.issue(tool, input);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"allow"')));
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.recentAudits().at(-1)?.behavior).toBe('auto_allow');
  }
});

it('fully automatic preserves hard URL denials', async () => {
  const h = setup('unrestricted'); h.issue('mcp__trylo-browser__browser_navigate', { url: 'javascript:alert(1)' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"reason":"policy_denied"')));
  expect(h.registry.list()).toEqual([]);
});

it('read-only does not offer a button that could approve an unknown external effect', async () => {
  const h = setup('read_only'); h.issue('mcp__custom__publish', {});
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"deny"')));
  expect(h.registry.list()).toEqual([]);
});

it('ask mode also prompts when a managed package classifies a workspace edit as automatic', () => {
  const h = setup('ask'); h.issue('mcp__trylo-kicad__place_component', { reference: 'R1' });
  expect(h.registry.list()).toHaveLength(1);
  expect(h.send).not.toHaveBeenCalled();
});

it('automatic edits distinguish non-destructive patches from deletion or movement', async () => {
  const h = setup('workspace_write');
  h.issue('apply_patch', { patch: '*** Begin Patch\n*** Add File: result.txt\n+hello\n*** End Patch' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"allow"')));
  for (const patch of ['*** Begin Patch\n*** Delete File: result.txt\n*** End Patch',
    '*** Begin Patch\n*** Update File: result.txt\n*** Move to: moved.txt\n@@\n-hello\n+hi\n*** End Patch']) {
    const pending = setup('workspace_write'); pending.issue('apply_patch', { patch });
    expect(pending.registry.list()).toHaveLength(1); expect(pending.send).not.toHaveBeenCalled();
  }
});

it('automatic edits require a human decision for an out-of-workspace target', async () => {
  const h = setup('workspace_write'); h.issue('write_file', { path: '../outside.txt', content: 'no' });
  await vi.waitFor(() => expect(h.registry.list()).toHaveLength(1));
  expect(h.send).not.toHaveBeenCalled();
  expect(await h.registry.respond(h.registry.list()[0]!.requestId, false)).toBe(true);
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"deny"')));
  expect(h.registry.list()).toEqual([]);
});

it.each(['D:/work/project/result.txt', 'd:\\work\\project\\result.txt'])('automatic editing accepts an absolute in-workspace target: %s', async path => {
  const h = setup('workspace_write'); h.issue('write_file', { path, content: 'proof' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"allow"')));
});

it.each(['D:/work/project-other/result.txt', 'D:/work/project/../outside.txt'])('unrestricted honors an explicit external target %j', async path => {
  const h = setup('unrestricted'); h.issue('write_file', { path, content: 'proof' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"allow"')));
});

it('file target validation still rejects a NUL path in unrestricted', async () => {
  const path = 'D:/work/project/a\u0000.txt';
  const h = setup('unrestricted'); h.issue('write_file', { path, content: 'no' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith('p', expect.stringContaining('"behavior":"deny"')));
});

it('a failed automatic denial cannot be changed into an approve button', async () => {
  const h = setup('read_only', vi.fn(async () => false));
  h.issue('mcp__trylo-browser__browser_evaluate', { function: '() => 1' });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
  await Promise.resolve(); expect(h.registry.list()).toEqual([]);
  expect(await h.registry.respond('r', true)).toBe(false);
});

it('an automatic reply cannot recreate a pending card after process cleanup', async () => {
  let finish!: (ok: boolean) => void;
  const h = setup('unrestricted', vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })));
  h.issue('mcp__trylo-browser__browser_snapshot', {});
  h.registry.clearProcess('p'); finish(false); await Promise.resolve(); await Promise.resolve();
  expect(h.registry.list()).toEqual([]);
});

it('fully automatic never supplies an answer to a user question', () => {
  const h = setup('unrestricted');
  h.registry.handleControlFrame({ kind: 'input', requestId: 'question', questions: [] }, {
    processId: 'p', projectKey: 'project', conversationId: 'c', permissionLevel: 'unrestricted', projectRoot: 'D:/work/project',
  });
  expect(h.send).not.toHaveBeenCalled(); expect(h.registry.list()).toEqual([]);
});
