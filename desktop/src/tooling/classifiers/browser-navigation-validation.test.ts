// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { classifyPlaywrightTool } from './playwright-classifier';
import { classifyChromeDevtoolsTool } from './chrome-devtools-classifier';
import { CodePermissionRegistry } from '../../runtime/code-permission-registry';
import { createToolRiskClassifier } from '../tool-risk-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';

const context = (toolName: string, input: Record<string, unknown>, permissionLevel: ToolRiskContext['permissionLevel']): ToolRiskContext => ({
  profileId: 'code.core.v1', packageId: 'playwright', toolName, input, permissionLevel,
  projectRoot: 'D:/work/project', conversationId: 'navigation-validation', at: 1,
});

for (const [name, classify, tool] of [
  ['Playwright', classifyPlaywrightTool, 'mcp__trylo-browser__browser_navigate'],
  ['Chrome', classifyChromeDevtoolsTool, 'mcp__trylo-chrome__navigate_page'],
] as const) {
  it(`${name} reports incomplete navigation addresses as argument failures without authorizing them`, () => {
    for (const permissionLevel of ['read_only', 'ask', 'workspace_write', 'unrestricted'] as const) {
      for (const url of ['index.html', '/game.html', '#paused', '?state=paused', '//example.com/game', 'example.com', 'localhost:1420', 'example.com:1420/game', '', 'http://', 'http://localhost:bad']) {
        expect(classify(context(tool, { url }, permissionLevel)), `${permissionLevel}: ${url}`).toMatchObject({
          behavior: 'deny', reasonCode: 'invalid_navigation_argument', failureCode: 'invalid_arguments',
        });
      }
    }
  });

  it(`${name} retains real policy refusals and accepts corrected absolute navigation`, () => {
    for (const url of ['javascript:123', 'data:text/html,test', 'about:blank', 'custom:123', 'https://user:secret@example.com/']) {
      const rejected = classify(context(tool, { url }, 'unrestricted'));
      expect(rejected.behavior).toBe('deny');
      expect(rejected).not.toHaveProperty('failureCode');
    }
    const blocked = classify(context(tool, { url: 'https://blocked.example/game' }, 'unrestricted'), { blockedOrigins: ['https://blocked.example'] });
    expect(blocked).toMatchObject({ behavior: 'deny', reasonCode: 'origin_blocked' });
    expect(blocked).not.toHaveProperty('failureCode');
    expect(classify(context(tool, { url: 'http://127.0.0.1:1420/index.html' }, 'unrestricted')).behavior).toBe('auto_allow');
  });
}

it('Chrome distinguishes missing URL arguments from its URL-free navigation operations', () => {
  for (const shortName of ['new_page', 'navigate_page']) {
    expect(classifyChromeDevtoolsTool(context(`mcp__trylo-chrome__${shortName}`, {}, 'unrestricted')))
      .toMatchObject({ behavior: 'deny', failureCode: 'invalid_arguments' });
  }
  for (const type of ['back', 'forward', 'reload']) {
    expect(classifyChromeDevtoolsTool(context('mcp__trylo-chrome__navigate_page', { type }, 'unrestricted')).behavior).toBe('auto_allow');
  }
});

it('the live host response distinguishes an argument error from a real policy denial', async () => {
  const sent: { response: { request_id: string; response: { behavior: string; reason?: string; message?: string } } }[] = [];
  const registry = new CodePermissionRegistry({ onChange() {}, riskClassifier: createToolRiskClassifier(),
    send: async (_process, line) => { sent.push(JSON.parse(line)); return true; } });
  const scope = { processId: 'p', projectKey: 'project', conversationId: 'navigation-validation', projectRoot: 'D:/work/project',
    permissionLevel: 'unrestricted' as const, profileId: 'code.core.v1', managedPackageIds: ['playwright'] };
  for (const [requestId, url] of [['relative', 'index.html'], ['corrected', 'http://127.0.0.1:1420/index.html'], ['forbidden', 'javascript:123']]) {
    registry.handleControlFrame({ kind: 'permission', requestId: requestId!, toolName: 'mcp__trylo-browser__browser_navigate', input: { url } }, scope);
  }
  await vi.waitFor(() => expect(sent).toHaveLength(3));
  const answer = (id: string) => sent.find(item => item.response.request_id === id)!.response.response;
  expect(answer('relative')).toMatchObject({ behavior: 'deny', reason: 'invalid_arguments' });
  expect(answer('relative').message).toMatch(/完整.*http\(s\).*URL/);
  expect(answer('corrected').behavior).toBe('allow');
  expect(answer('forbidden')).toMatchObject({ behavior: 'deny', reason: 'policy_denied' });
  expect(registry.list()).toHaveLength(0);
});
