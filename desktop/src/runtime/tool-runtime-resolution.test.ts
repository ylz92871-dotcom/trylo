// Trylo Desktop — Tool Profile resolution through the run path.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §4.2 / §4.3 / §9.
// Pins the three contracts PR-1 must not break:
//   1. Work asks for `work.core.v1` and never inherits Code's Hermes argv.
//   2. Code without a Profile keeps the legacy Hermes degrade path, and a
//      resolver outage changes nothing observable.
//   3. A Profile change (or a permission change) never reuses a live
//      process — the full runtime contract decides, not the argv.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessExitInfo } from '../host-adapter/process-service';
import type { ResolvedToolRuntime } from '../tooling/types';
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier';

const spawned: Spawned[] = [];
const stopCalls: string[] = [];

interface Spawned {
  id: string;
  onOutput: (line: string) => void;
  onExit: (info: ProcessExitInfo) => void;
  metadata: Record<string, string | undefined>;
  label: string;
  args: readonly string[];
  env: Record<string, string>;
  promptLines: string[];
}

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null;
  },
  invoke: vi.fn(async () => undefined),
}));

vi.mock('../host-adapter/index', async () => ({
  hostAdapter: {
    process: {
      spawn: async (req: {
        command: string;
        args: readonly string[];
        label: string;
        env?: Record<string, string>;
        metadata?: Record<string, string | undefined>;
        onOutput: (line: string) => void;
        onExit?: (info: ProcessExitInfo) => void;
      }) => {
        const id = `proc-${spawned.length + 1}`;
        spawned.push({
          id,
          onOutput: req.onOutput,
          onExit: (info) => req.onExit?.(info),
          metadata: req.metadata ?? {},
          label: req.label,
          args: req.args,
          env: req.env ?? {},
          promptLines: [],
        });
        return { id, pid: spawned.length, label: req.label, command: req.command };
      },
      send: async (processId: string, line: string) => {
        const s = spawned.find((x) => x.id === processId);
        if (s) s.promptLines.push(line);
      },
      stop: async (processId: string) => {
        stopCalls.push(processId);
      },
      list: async () => [],
    },
    fs: { readFile: async () => '', statFile: async () => ({ size: 0 }) },
  },
}));

// Import AFTER the mock.
import { ConversationRunSupervisor } from './conversation-run-supervisor';
import { CodeRunController } from './code-run-controller';
import { CodePermissionRegistry } from './code-permission-registry';
import { CodeDiagnosticsBuffer } from '../diagnostics/code-diagnostics-buffer';
import type { SettingsForCodeRun } from './runtime-types';

const baseSettings: SettingsForCodeRun = {
  cliPath: 'D:/cli/cli.js',
  cwd: 'D:/work',
  apiKey: 'sk-test',
  apiHost: 'https://api.example.com',
  apiModel: 'model-a',
  systemPrompt: 'global prompt',
};

function request(prompt: string, permissionLevel: SettingsForCodeRun extends never ? never : 'read_only' | 'ask' | 'workspace_write' | 'unrestricted' = 'workspace_write') {
  return {
    prompt,
    settings: baseSettings,
    codeMode: 'agent' as const,
    permissionLevel,
    priorMessages: [],
    onEvents: () => {},
  };
}

function runtime(profileId: string, revision = '1'): ResolvedToolRuntime {
  return {
    profileId,
    profileRevision: revision,
    surface: profileId.startsWith('work.') ? 'work' : 'code',
    mcpConfigPath: 'D:/profiles/mcp.json',
    mcpConfigHash: `hash-${profileId}-${revision}`,
    permissionSettingsPath: 'D:/profiles/settings.json',
    permissionSettingsHash: `sHash-${profileId}`,
    cliArgs: ['--mcp-config', 'D:/profiles/mcp.json', '--settings', 'D:/profiles/settings.json', '--strict-mcp-config'],
    spawnEnv: { TRYLO_TOOL_PROFILE: profileId },
    serverNames: ['trylo-office'],
    packageHealth: [],
    unavailableCapabilities: [],
    strictMcpConfig: true,
    resolvedAt: 0,
  };
}

function warmIdle(index: number): void {
  // Emit the structured ready frame so the idle process is adoptable.
  spawned[index]?.onOutput(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
}

/** Finish the turn started on process `index`. */
function finishTurn(index: number): void {
  spawned[index]?.onOutput(JSON.stringify({ type: 'result', subtype: 'success' }));
}

beforeEach(() => {
  spawned.length = 0;
  stopCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tool Profile resolution (spec §4.2/§4.3)', () => {
  it('a Work run asks for its own Profile and spawns with the Profile argv', async () => {
    const seen: string[] = [];
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async (ctx) => {
        seen.push(`${ctx.surface}:${ctx.requestedProfileId ?? ''}`);
        return runtime('work.core.v1');
      },
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });

    expect(seen).toEqual(['work:work.core.v1']);
    // §4.2: the Profile flags travel with the spawn.
    expect(spawned[0]!.args).toContain('--strict-mcp-config');
    expect(spawned[0]!.args).toContain('D:/profiles/mcp.json');
    // §4.2: the Profile's process env reaches the child, and it may not
    // overwrite the auth env.
    expect(spawned[0]!.env.TRYLO_TOOL_PROFILE).toBe('work.core.v1');
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('a Code run without a Profile falls back to the legacy Hermes args', async () => {
    const sup = new ConversationRunSupervisor({
      resolveCodeCliArgs: async () => ['--mcp-config', 'hermes.json'],
      // The Tool Platform is up but has no answer for Code.
      resolveToolRuntime: async () => null,
    });
    await sup.runCode('proj', 'convA', request('code task'));

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain('hermes.json');
    expect(spawned[0]!.args).not.toContain('--strict-mcp-config');
  });

  it('a resolver outage degrades to the legacy path instead of failing the run', async () => {
    const sup = new ConversationRunSupervisor({
      resolveCodeCliArgs: async () => ['--mcp-config', 'hermes.json'],
      resolveToolRuntime: async () => {
        throw new Error('sidecar exploded');
      },
    });
    await expect(sup.runCode('proj', 'convA', request('still works'))).resolves.toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain('hermes.json');
  });

  it('an explicit toolRuntime:null skips the resolver entirely', async () => {
    let asked = 0;
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => {
        asked += 1;
        return runtime('work.core.v1');
      },
    });
    await sup.runCode('proj', 'convA', { ...request('plain'), toolRuntime: null });
    expect(asked).toBe(0);
    expect(spawned[0]!.args).not.toContain('--strict-mcp-config');
  });

  it('a Work run without a Profile still injects TRYLO_TEAM_SURFACE and does not share a Code process', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => null,
    });
    await sup.runCode('proj', 'convA', { ...request('code'), surface: 'code', toolRuntime: null });
    finishTurn(0);
    await sup.runCode('proj', 'convA', { ...request('work'), surface: 'work', toolRuntime: null });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.env.TRYLO_TEAM_SURFACE).toBeUndefined();
    expect(spawned[1]!.env.TRYLO_TEAM_SURFACE).toBe('work');
    expect(stopCalls).toContain('proc-1');
  });
});

describe('RuntimeFingerprint reuse (spec §9)', () => {
  it('a second turn with the same contract reuses the warm process', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => runtime('work.core.v1'),
    });
    const opts = { surface: 'work' as const, requestedProfileId: 'work.core.v1' };
    await sup.runCode('proj', 'convA', { ...request('one'), surface: opts.surface, requestedProfileId: opts.requestedProfileId });
    finishTurn(0);
    await sup.runCode('proj', 'convA', { ...request('two'), surface: opts.surface, requestedProfileId: opts.requestedProfileId });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.promptLines).toHaveLength(2);
  });

  it('a different Profile never reuses the live process (§9)', async () => {
    let profile = 'work.core.v1';
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => runtime(profile),
    });
    const opts = { surface: 'work' as const, requestedProfileId: 'work.core.v1' };
    await sup.runCode('proj', 'convA', { ...request('one'), surface: opts.surface, requestedProfileId: opts.requestedProfileId });
    finishTurn(0);

    profile = 'work.cad.v1';
    await sup.runCode('proj', 'convA', { ...request('two'), surface: opts.surface, requestedProfileId: opts.requestedProfileId });
    // The old process was stopped (no orphan) and a fresh one spawned.
    expect(stopCalls).toContain('proc-1');
    expect(spawned).toHaveLength(2);
  });

  it('a permission-level change never reuses the live process (§1.4/§9)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => runtime('work.core.v1'),
    });
    await sup.runCode('proj', 'convA', { ...request('one'), surface: 'work', requestedProfileId: 'work.core.v1', permissionLevel: 'ask' });
    finishTurn(0);
    await sup.runCode('proj', 'convA', { ...request('two'), surface: 'work', requestedProfileId: 'work.core.v1', permissionLevel: 'unrestricted' });
    expect(stopCalls).toContain('proc-1');
    expect(spawned).toHaveLength(2);
  });

  it('a Work run cannot adopt a plain Code prewarm (different contract)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async (ctx) => (ctx.surface === 'work' ? runtime('work.core.v1') : null),
    });
    // Plain Code prewarm: no Profile, default level.
    await sup.prewarmCode('proj', 'convA', baseSettings, { surface: 'code' });
    warmIdle(0);

    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });
    // The Work contract does not match the idle Code process, so the run
    // cold-spawns and the idle process is stopped rather than orphaned.
    expect(spawned).toHaveLength(2);
    expect(stopCalls).toContain('proc-1');
  });

  it('a Work prewarm IS adopted by a Work run of the same Profile (§9)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => runtime('work.core.v1'),
    });
    await sup.prewarmCode('proj', 'convA', baseSettings, {
      surface: 'work',
      requestedProfileId: 'work.core.v1',
      permissionLevel: 'workspace_write',
    });
    warmIdle(0);

    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
      permissionLevel: 'workspace_write',
    });
    // Adopted: no second spawn, no stop.
    expect(spawned).toHaveLength(1);
    expect(stopCalls).toHaveLength(0);
    expect(spawned[0]!.promptLines).toHaveLength(1);
  });
});

describe('PR-2: host risk classifier on the live control-request path (§6)', () => {
  const OFFICECLI_TOOL = 'mcp__trylo-office__officecli';

  /** The PR-1 runtime shape, with an AVAILABLE officecli in its health. */
  function workRuntime(): ResolvedToolRuntime {
    return {
      ...runtime('work.core.v1'),
      packageHealth: [
        {
          id: 'officecli',
          version: '1.0.145',
          displayName: 'OfficeCLI',
          adoption: 'trial',
          serverName: 'trylo-office',
          state: 'installed',
          available: true,
          detail: 'ok',
          autoUpdate: false,
          expectedTools: ['officecli'],
          protocol: 'not-checked',
          checkedAt: 0,
          reportedVersion: null,
          versionMatches: null,
        },
      ],
    };
  }

  function controlRequestLine(requestId: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: OFFICECLI_TOOL, input },
    });
  }

  function lastStdinResponse(index: number): { allowed: boolean; message?: string; requestId: string } {
    const line = spawned[index]!.promptLines.at(-1)!;
    const parsed = JSON.parse(line.trim());
    return {
      allowed: parsed.response.response.behavior === 'allow',
      message: parsed.response.response.message as string | undefined,
      requestId: parsed.response.request_id,
    };
  }

  it('an in-workspace read at workspace_write is auto-answered allow, no UI', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });

    spawned[0]!.onOutput(controlRequestLine('req-read', { command: 'view', file: 'docs/a.docx' }));
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1));
    const response = lastStdinResponse(0);
    expect(response.allowed).toBe(true);
    expect(response.requestId).toBe('req-read');
    // §6.2: 自动批准也写安全审计摘要.
    expect(sup.toolRiskAudits()).toHaveLength(1);
    expect(sup.toolRiskAudits()[0]).toMatchObject({ behavior: 'auto_allow', packageId: 'officecli' });
    // No approval card was ever projected.
    expect(sup.pendingCodePermissions()).toEqual([]);
  });

  it('read_only denies a create before any human ever sees it (PR-2 验收)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      permissionLevel: 'read_only',
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });

    spawned[0]!.onOutput(controlRequestLine('req-create', { command: 'create', output: '.trylo/out/a.docx' }));
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1));
    const response = lastStdinResponse(0);
    expect(response.allowed).toBe(false);
    expect(response.message).toContain('read-only');
    expect(sup.pendingCodePermissions()).toEqual([]);
  });

  it('a workspace original modification prompts — pending with the safe preview (PR-2 验收)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });

    spawned[0]!.onOutput(controlRequestLine('req-orig', { command: 'set', file: 'docs/a.docx' }));
    await vi.waitFor(() => expect(sup.pendingCodePermissions()).toHaveLength(1));
    const pending = sup.pendingCodePermissions()[0]!;
    expect(pending.risk).toBe('sensitive');
    expect(pending.preview?.target).toContain('docs/a.docx');
    // The original input stays untouched for the control_response round-trip.
    expect(pending.input).toEqual({ command: 'set', file: 'docs/a.docx' });
    // No stdin write happened yet — the human is the decision surface.
    expect(spawned[0]!.promptLines).toHaveLength(1); // only the user prompt
  });

  it('an unexpected tool on the managed server is denied, never guessed', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });
    spawned[0]!.onOutput(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-drift',
        request: { subtype: 'can_use_tool', tool_name: 'mcp__trylo-office__rogue', input: {} },
      }),
    );
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1));
    const response = lastStdinResponse(0);
    expect(response.allowed).toBe(false);
    expect(response.message).toContain('pinned tool set');
    expect(sup.toolRiskAudits()[0]).toMatchObject({ reasonCode: 'unknown_tool' });
  });

  it('a built-in tool is untouched by the classifier (legacy approval path)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    });
    spawned[0]!.onOutput(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-bash',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      }),
    );
    // Let microtasks flush — a buggy auto-respond would have written by now.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned[0]!.promptLines).toHaveLength(1);
    expect(sup.pendingCodePermissions().map((r) => r.requestId)).toEqual(['req-bash']);
  });

  it('a prewarmed Work CLI\u2019s control requests classify with the prewarm\u2019s own contract', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    });
    await sup.prewarmCode('proj', 'convA', baseSettings, {
      surface: 'work',
      requestedProfileId: 'work.core.v1',
      permissionLevel: 'workspace_write',
    });
    warmIdle(0);
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
      permissionLevel: 'workspace_write',
    });
    // Adopted: no second spawn; the idle process's stdout still flows
    // through the prewarm closure, whose classifier scope was snapshotted
    // from the prewarm's OWN contract (§9 exact-match adoption keeps the
    // two identical).
    expect(spawned).toHaveLength(1);
    spawned[0]!.onOutput(controlRequestLine('req-prewarm', { command: 'view', file: 'docs/a.docx' }));
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1));
    const response = lastStdinResponse(0);
    expect(response.allowed).toBe(true);
    expect(response.requestId).toBe('req-prewarm');
    expect(sup.pendingCodePermissions()).toEqual([]);
    expect(sup.toolRiskAudits()).toHaveLength(1);
  });

  it('records tools/list drift from the init frame into run diagnostics (§4.4)', async () => {
    const buffer = new CodeDiagnosticsBuffer();
    const controller = new CodeRunController({
      projectKey: 'proj',
      conversationId: 'convA',
      onChange: () => {},
      diagnostics: buffer,
      permissions: new CodePermissionRegistry({ onChange: () => {} }),
    });
    await controller.run({
      ...request('work task'),
      toolRuntime: workRuntime(),
      permissionLevel: 'workspace_write',
    });
    // The CLI reports its tool list WITHOUT the pinned officecli tool.
    spawned[0]!.onOutput(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: [] }));
    const snapshot = buffer.snapshot();
    const drift = snapshot.events.filter((e) => e.type === 'tool.protocol_drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]!.reasonCode).toBe('officecli:missing:mcp__trylo-office__officecli,extra:-');
  });

  it('an exact tool list records NO drift event', async () => {
    const buffer = new CodeDiagnosticsBuffer();
    const controller = new CodeRunController({
      projectKey: 'proj',
      conversationId: 'convA',
      onChange: () => {},
      diagnostics: buffer,
      permissions: new CodePermissionRegistry({ onChange: () => {} }),
    });
    await controller.run({
      ...request('work task'),
      toolRuntime: workRuntime(),
      permissionLevel: 'workspace_write',
    });
    spawned[0]!.onOutput(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        tools: ['mcp__trylo-office__officecli'],
      }),
    );
    expect(buffer.snapshot().events.filter((e) => e.type === 'tool.protocol_drift')).toEqual([]);
  });
});
