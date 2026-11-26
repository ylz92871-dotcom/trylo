import { describe, expect, it } from 'vitest';
import type { ResolvedToolRuntime, ToolUnavailableCapability } from '../services-host/methods';
import { toolAvailabilitySystemPrompt } from './tool-availability-context';

describe('tool availability context instead of a send veto', () => {
  it('preserves the caller prompt when no package capability is unavailable', () => {
    expect(toolAvailabilitySystemPrompt(undefined)).toBeUndefined();
    expect(toolAvailabilitySystemPrompt('Keep the caller instructions.', [])).toBe('Keep the caller instructions.');
  });

  it('carries missing built-in capabilities and their recovery path to the agent', () => {
    const unavailable: ToolUnavailableCapability[] = [
      { id: 'officecli', type: 'package', displayName: 'OfficeCLI', reasonCode: 'runtime_changed', userMessage: 'D:/private/office.exe', detail: 'private runtime path' },
      { id: 'windows-mcp', type: 'package', displayName: 'Windows-MCP', reasonCode: 'runtime_changed', userMessage: 'private input runtime' },
      { id: 'playwright', type: 'package', displayName: 'Playwright MCP', reasonCode: 'runtime_changed', userMessage: 'private browser runtime' },
    ];
    const prompt = toolAvailabilitySystemPrompt('Keep the caller instructions.', unavailable);

    expect(prompt).toContain('Keep the caller instructions.');
    for (const name of ['OfficeCLI', 'Windows-MCP', 'Playwright MCP']) expect(prompt?.split(name)).toHaveLength(2);
    expect(prompt).toContain('本轮实际工具目录');
    expect(prompt).toContain('重新检测或重载工具服务');
    expect(prompt).toContain('修复或更新 Trylo');
    expect(prompt).toContain('仅在当前任务确实需要');
    expect(prompt).toContain('不得自动启用、安装或切换工具');
    expect(prompt).toContain('不得绕过用户权限与审批');
    expect(prompt).toContain('不要在每轮开头主动重复报告缺失工具');
    expect(prompt).not.toMatch(/private|已阻止发送/);
    expect(unavailable[0]?.reasonCode).toBe('runtime_changed');
  });
});

function runtime(changes: Partial<ResolvedToolRuntime> = {}): ResolvedToolRuntime {
  return {
    profileId: 'code.core.v1', profileRevision: 'test', surface: 'code',
    mcpConfigPath: 'D:/private/mcp.json', mcpConfigHash: 'mcp-hash',
    permissionSettingsPath: 'D:/private/settings.json', permissionSettingsHash: 'settings-hash',
    cliArgs: [], spawnEnv: { SECRET_TOKEN: 'secret-runtime-token' },
    serverNames: ['trylo-office', 'trylo-browser', 'trylo-windows'], packageHealth: [],
    unavailableCapabilities: [], strictMcpConfig: false, resolvedAt: 0, ...changes,
  };
}

describe('current built-in declaration from the immutable run snapshot', () => {
  it('declares configured servers and discovery without claiming a connection or exposing runtime details', () => {
    const snapshot = runtime();
    const before = JSON.stringify(snapshot);
    const prompt = toolAvailabilitySystemPrompt('Keep the caller instructions.', { runtime: snapshot });
    expect(prompt?.startsWith('Keep the caller instructions.')).toBe(true);
    for (const server of snapshot.serverNames) expect(prompt).toContain(`server=${server}`);
    expect(prompt).toContain('本轮已配置');
    expect(prompt).toContain('mcp_search_tools');
    expect(prompt).toContain('{"query":"浏览器截图"}');
    expect(prompt).toContain('mcp_call_tool');
    expect(prompt).toContain('不是连接成功');
    expect(prompt).toContain('一次搜索无匹配');
    expect(prompt).toContain('load_skill');
    expect(prompt).toContain('string');
    expect(prompt).toContain('array');
    expect(prompt).toContain('dump');
    expect(prompt).toContain('.trylo/out');
    expect(prompt).toContain('inline');
    expect(prompt).toContain('坐标');
    expect(prompt).not.toMatch(/private|secret-runtime-token|已连接可执行/);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('describes the configured Chrome adapter without inventing Playwright tool names or path restrictions', () => {
    const prompt = toolAvailabilitySystemPrompt(undefined, {
      runtime: runtime({ serverNames: ['trylo-chrome'] }),
    });
    expect(prompt).toContain('server=trylo-chrome');
    expect(prompt).toContain('list_pages');
    expect(prompt).toContain('pageId');
    expect(prompt).not.toContain('browser_navigate');
    expect(prompt).not.toContain('server=trylo-browser');
    expect(prompt).not.toMatch(/只能.*绝对|必须.*绝对/);
  });

  it('describes macOS desktop tools with their actual permission and coordinate contract', () => {
    const prompt = toolAvailabilitySystemPrompt(undefined, { runtime: runtime({ serverNames: ['trylo-macos'] }) });
    expect(prompt).toContain('server=trylo-macos');
    expect(prompt).toContain('status 检查系统授权');
    expect(prompt).toContain('全局屏幕点坐标');
    expect(prompt).not.toContain('Snapshot/Screenshot');
  });

  it('keeps unready reasons, explicit nonselection and unmounted capabilities distinct without leaking messages', () => {
    const prompt = toolAvailabilitySystemPrompt(undefined, {
      computerUse: false,
      runtime: runtime({ serverNames: [], unavailableCapabilities: [
        { id: 'officecli', type: 'package', displayName: 'OfficeCLI', reasonCode: 'runtime_changed',
          userMessage: 'D:/private/office.exe', detail: 'private runtime path' },
      ] }),
    });
    expect(prompt).toContain('OfficeCLI：未就绪');
    expect(prompt).toContain('reasonCode=runtime_changed');
    expect(prompt).toContain('浏览器：本轮未挂载');
    expect(prompt).toContain('电脑控制：本轮明确未选用');
    expect(prompt).not.toMatch(/private|用户.*(?:关闭|禁用)|load_skill/);
  });

  it('does not treat a missing snapshot or a prior availability report as a user choice', () => {
    const prompt = toolAvailabilitySystemPrompt('Earlier turn reported a browser failure.', { runtime: null });
    expect(prompt).toContain('本轮工具配置快照缺失');
    expect(prompt).toContain('不是用户禁用');
    expect(prompt).not.toContain('本轮已配置');
    expect(prompt).not.toContain('server=');
    expect(prompt).toContain('Earlier turn reported a browser failure.');
  });

  it('uses the actual configured server identifier from package health', () => {
    const prompt = toolAvailabilitySystemPrompt(undefined, { runtime: runtime({
      serverNames: ['office-local'], packageHealth: [{
        id: 'officecli', version: 'local', displayName: 'OfficeCLI', adoption: 'developer',
        serverName: 'office-local', state: 'override', available: true, detail: 'D:/private/custom.exe',
        autoUpdate: false, expectedTools: ['officecli'], protocol: 'not-checked', checkedAt: 0,
        reportedVersion: null, versionMatches: null,
      }],
    }) });
    expect(prompt).toContain('server=office-local');
    expect(prompt).not.toContain('server=trylo-office');
    expect(prompt).not.toContain('private');
  });

  it('retains an optional package failure beside healthy configured built-ins without leaking its details', () => {
    const prompt = toolAvailabilitySystemPrompt(undefined, { runtime: runtime({ unavailableCapabilities: [
      { id: 'autocad-mcp', type: 'package', displayName: 'D:/private/AutoCAD', reasonCode: 'runtime_changed',
        userMessage: 'D:/private/acad.exe', detail: 'private optional runtime' },
      { id: 'hermes', type: 'adapter', reasonCode: 'hermes_unavailable', userMessage: 'private adapter details' },
    ] }) });
    for (const server of ['trylo-office', 'trylo-browser', 'trylo-windows']) expect(prompt).toContain(`server=${server}`);
    expect(prompt).toContain('扩展 autocad-mcp：未就绪');
    expect(prompt).toContain('reasonCode=runtime_changed');
    expect(prompt).toContain('重新检测或重载工具服务');
    expect(prompt).not.toMatch(/private|hermes/);
  });
});
