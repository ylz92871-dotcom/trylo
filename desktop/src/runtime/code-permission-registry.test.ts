// Trylo Desktop — Code permission registry tests (spec §6.4 Code path):
// register/cancel/clear/respond routing, stdin write shape, and the
// dual-workspace requestId routing guarantee (architecture doc §5.4-3).
// PR-2: the host risk classifier contract — auto_allow/deny answered
// before projection, prompt (and only prompt) becomes pending, unmanaged
// tools keep the legacy path, and a failed auto-respond write degrades to
// a human decision instead of dropping the request.

import { describe, expect, it, vi } from 'vitest';

import { CodePermissionRegistry } from './code-permission-registry';
import type { ControlFrame } from '../host-adapter/control-protocol';
import type { BrowserLeaseGrant, ToolLeaseGrant, ToolRiskRoute, ToolRiskRouter } from '../tooling/tool-risk-classifier';

const SCOPE_A = { processId: 'proc-a', projectKey: 'p1', conversationId: 'c1' };
const SCOPE_B = { processId: 'proc-b', projectKey: 'p2', conversationId: 'c2' };
// PR-2: a scope carrying the classifier context (§6.2).
const CLASSIFIER_SCOPE = {
  ...SCOPE_A,
  projectRoot: 'D:/work/proj',
  permissionLevel: 'workspace_write' as const,
  profileId: 'work.core.v1',
  managedPackageIds: ['officecli'],
};

const OFFICECLI_TOOL = 'mcp__trylo-office__officecli';

function permissionFrame(requestId: string): ControlFrame {
  return { kind: 'permission', requestId, toolName: 'Bash', input: { command: 'ls' }, title: 'Run ls' };
}

function mcpFrame(requestId: string, input: Record<string, unknown> = { command: 'view', file: 'a.docx' }): ControlFrame {
  return { kind: 'permission', requestId, toolName: OFFICECLI_TOOL, input };
}

/** Classifier stub: route the officecli tool as told, everything else unmanaged. */
function stubRouter(routeForOfficecli: ToolRiskRoute): ToolRiskRouter {
  return {
    serverNames: () => ['trylo-office'],
    classify: (req) =>
      req.toolName === OFFICECLI_TOOL ? routeForOfficecli : { behavior: 'unmanaged' },
  };
}

function createRegistry(options: {
  riskClassifier?: ToolRiskRouter | null;
  onLeaseGrant?: (grant: ToolLeaseGrant) => void;
} = {}) {
  const sent: { processId: string; line: string }[] = [];
  const changes: number[] = [];
  let failSend = false;
  const registry = new CodePermissionRegistry({
    onChange: () => changes.push(Date.now()),
    send: async (processId, line) => {
      if (failSend) return false;
      sent.push({ processId, line });
      return true;
    },
    ...options,
  });
  return { registry, sent, changes, setFailSend: (v: boolean) => (failSend = v) };
}

describe('CodePermissionRegistry', () => {
  it('registers a pending request and notifies', () => {
    const { registry, changes } = createRegistry();
    registry.handleControlFrame(permissionFrame('req-1'), SCOPE_A);
    expect(registry.list().length).toBe(1);
    expect(registry.list()[0]).toMatchObject({
      requestId: 'req-1',
      processId: 'proc-a',
      projectKey: 'p1',
      conversationId: 'c1',
      toolName: 'Bash',
      title: 'Run ls',
    });
    expect(changes.length).toBe(1);
  });

  it('routes the response to the owning process, not the "current" one', async () => {
    const { registry, sent } = createRegistry();
    registry.handleControlFrame(permissionFrame('req-a'), SCOPE_A);
    registry.handleControlFrame(permissionFrame('req-b'), SCOPE_B);
    expect(await registry.respond('req-a', true)).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]?.processId).toBe('proc-a');
    const parsed = JSON.parse(sent[0]!.line.trim());
    expect(parsed.response.request_id).toBe('req-a');
    expect(parsed.response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    // req-b stays pending on its own process.
    expect(registry.list().map((r) => r.requestId)).toEqual(['req-b']);
  });

  it('deny carries a message and removes the entry', async () => {
    const { registry, sent } = createRegistry();
    registry.handleControlFrame(permissionFrame('req-d'), SCOPE_B);
    expect(await registry.respond('req-d', false)).toBe(true);
    const parsed = JSON.parse(sent[0]!.line.trim());
    expect(parsed.response.response.behavior).toBe('deny');
    expect(registry.list()).toEqual([]);
  });

  it('respond resolves false for unknown ids without writing', async () => {
    const { registry, sent } = createRegistry();
    expect(await registry.respond('nope', true)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('keeps the entry when the stdin write fails (retryable)', async () => {
    const h = createRegistry();
    h.registry.handleControlFrame(permissionFrame('req-f'), SCOPE_A);
    h.setFailSend(true);
    expect(await h.registry.respond('req-f', true)).toBe(false);
    expect(h.registry.list().length).toBe(1);
    h.setFailSend(false);
    expect(await h.registry.respond('req-f', true)).toBe(true);
    expect(h.registry.list()).toEqual([]);
  });

  it('cancel removes only the matching request', () => {
    const { registry } = createRegistry();
    registry.handleControlFrame(permissionFrame('req-1'), SCOPE_A);
    registry.handleControlFrame(permissionFrame('req-2'), SCOPE_A);
    registry.handleControlFrame({ kind: 'cancel', requestId: 'req-1' }, SCOPE_A);
    expect(registry.list().map((r) => r.requestId)).toEqual(['req-2']);
  });

  it('clearProcess drops that process pending set and notifies once changed', () => {
    const { registry, changes } = createRegistry();
    registry.handleControlFrame(permissionFrame('req-1'), SCOPE_A);
    registry.handleControlFrame(permissionFrame('req-2'), SCOPE_B);
    registry.clearProcess('proc-a');
    expect(registry.list().map((r) => r.requestId)).toEqual(['req-2']);
    registry.clearProcess('proc-a'); // no change → no extra notify
    expect(changes.length).toBe(3); // 2 registers + 1 clear
  });
});

describe('supervisor integration surface', () => {
  it('exposes pendingCodePermissions + respondCodePermission backed by the shared registry', async () => {
    // Directly assert the aggregation contract without spawning CLIs:
    // the supervisor owns one registry and routes through it.
    const { ConversationRunSupervisor } = await import('./conversation-run-supervisor');
    const supervisor = new ConversationRunSupervisor();
    const controller = supervisor.controller('p1', 'c1');
    const registryHandle = (supervisor as unknown as { permissions: CodePermissionRegistry }).permissions;
    registryHandle.handleControlFrame(permissionFrame('req-sup'), { processId: 'proc-x', projectKey: 'p1', conversationId: 'c1' });
    expect(supervisor.pendingCodePermissions().length).toBe(1);
    expect(controller.pendingPermissions().length).toBe(1);
    const sent: string[] = [];
    const respond = vi.spyOn(registryHandle, 'respond').mockImplementation(async (id: string, allow: boolean) => {
      sent.push(`${id}:${allow}`);
      return true;
    });
    expect(await supervisor.respondCodePermission('req-sup', false)).toBe(true);
    expect(sent).toEqual(['req-sup:false']);
    respond.mockRestore();
  });
});

describe('PR-2: host risk classifier integration (§6 / §12.2)', () => {
  function audit(
    behavior: 'auto_allow' | 'prompt' | 'deny',
    risk: 'read' | 'workspace-write' | 'external' | 'sensitive' | 'destructive' | null,
    reasonCode: string,
    pathZones: readonly { field: string; zone: string }[] = [],
  ) {
    return {
      at: 1,
      profileId: 'work.core.v1',
      packageId: 'officecli',
      toolName: OFFICECLI_TOOL,
      behavior,
      risk,
      reasonCode,
      inputDigest: 'deadbeefdeadbeef',
      pathZones,
    };
  }

  const autoAllow: Extract<ToolRiskRoute, { behavior: 'auto_allow' }> = {
    behavior: 'auto_allow',
    risk: 'read',
    reasonCode: 'workspace_read',
    audit: audit('auto_allow', 'read', 'workspace_read', [{ field: 'file', zone: 'workspace' }]),
  };
  const prompt: Extract<ToolRiskRoute, { behavior: 'prompt' }> = {
    behavior: 'prompt',
    risk: 'destructive',
    reasonCode: 'remove_requires_approval',
    preview: { kind: 'summary', title: 'Office 文档操作', target: 'remove · a.docx', reason: '需审批' },
    audit: audit('prompt', 'destructive', 'remove_requires_approval'),
  };
  const deny: Extract<ToolRiskRoute, { behavior: 'deny' }> = {
    behavior: 'deny',
    reasonCode: 'write_denied_read_only',
    userMessage: 'Denied: read-only.',
    audit: audit('deny', null, 'write_denied_read_only'),
  };

  it('auto_allow is answered on stdin immediately and never becomes pending', async () => {
    const h = createRegistry({ riskClassifier: stubRouter(autoAllow) });
    h.registry.handleControlFrame(mcpFrame('req-auto'), CLASSIFIER_SCOPE);
    // The response is written without any UI projection.
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.processId).toBe('proc-a');
    const parsed = JSON.parse(h.sent[0]!.line.trim());
    expect(parsed.response.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'view', file: 'a.docx' },
    });
    expect(h.registry.list()).toEqual([]);
    // §6.2: 自动批准也写安全审计摘要.
    expect(h.registry.recentAudits()).toHaveLength(1);
    expect(h.registry.recentAudits()[0]).toMatchObject({
      requestId: 'req-auto',
      behavior: 'auto_allow',
      packageId: 'officecli',
    });
  });

  it('deny is answered immediately with the classifier message', async () => {
    const h = createRegistry({ riskClassifier: stubRouter(deny) });
    h.registry.handleControlFrame(mcpFrame('req-deny'), { ...CLASSIFIER_SCOPE, permissionLevel: 'read_only' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const parsed = JSON.parse(h.sent[0]!.line.trim());
    expect(parsed.response.response.behavior).toBe('deny');
    expect(parsed.response.response.message).toBe('Denied: read-only.');
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.recentAudits()[0]!.behavior).toBe('deny');
  });

  it('prompt becomes pending with the safe preview + risk attached', () => {
    const h = createRegistry({ riskClassifier: stubRouter(prompt) });
    h.registry.handleControlFrame(mcpFrame('req-prompt'), CLASSIFIER_SCOPE);
    expect(h.sent).toEqual([]);
    const pending = h.registry.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      requestId: 'req-prompt',
      toolName: OFFICECLI_TOOL,
      risk: 'destructive',
    });
    expect(pending[0]!.preview?.target).toContain('remove');
    // The user can still answer it through the normal respond path.
    return expect(h.registry.respond('req-prompt', false)).resolves.toBe(true);
  });

  it('unmanaged tools keep the legacy register-and-wait path', () => {
    const h = createRegistry({ riskClassifier: stubRouter(autoAllow) });
    h.registry.handleControlFrame(permissionFrame('req-bash'), CLASSIFIER_SCOPE);
    h.registry.handleControlFrame(
      { kind: 'permission', requestId: 'req-other', toolName: 'mcp__trylo-hermes-capabilities__search', input: {} },
      CLASSIFIER_SCOPE,
    );
    expect(h.sent).toEqual([]);
    expect(h.registry.list().map((r) => r.requestId)).toEqual(['req-bash', 'req-other']);
    expect(h.registry.list().every((r) => r.preview === undefined)).toBe(true);
  });

  it('a scope without classifier context skips classification (never a guess)', () => {
    const h = createRegistry({ riskClassifier: stubRouter(autoAllow) });
    h.registry.handleControlFrame(mcpFrame('req-noscope'), SCOPE_A); // no projectRoot/permissionLevel
    expect(h.sent).toEqual([]);
    expect(h.registry.list().map((r) => r.requestId)).toEqual(['req-noscope']);
  });

  it('a failed auto-respond write degrades to a pending human decision', async () => {
    const h = createRegistry({ riskClassifier: stubRouter(autoAllow) });
    h.setFailSend(true);
    h.registry.handleControlFrame(mcpFrame('req-fail'), CLASSIFIER_SCOPE);
    await vi.waitFor(() => expect(h.registry.list()).toHaveLength(1));
    expect(h.sent).toEqual([]);
    // Recover the transport; the user (not the classifier) now decides.
    h.setFailSend(false);
    await expect(h.registry.respond('req-fail', true)).resolves.toBe(true);
  });

  it('a classifier crash routes to a human instead of guessing (fail-closed, fail-visible)', () => {
    const exploding: ToolRiskRouter = {
      serverNames: () => ['trylo-office'],
      classify: () => {
        throw new Error('classifier bug');
      },
    };
    const h = createRegistry({ riskClassifier: exploding });
    h.registry.handleControlFrame(mcpFrame('req-boom'), CLASSIFIER_SCOPE);
    expect(h.sent).toEqual([]);
    expect(h.registry.list().map((r) => r.requestId)).toEqual(['req-boom']);
  });

  it('audit history is bounded', () => {
    let n = 0;
    const many: ToolRiskRouter = {
      serverNames: () => ['trylo-office'],
      classify: () => ({
        ...autoAllow,
        audit: { ...autoAllow.audit, at: ++n },
      }),
    };
    const h = createRegistry({ riskClassifier: many });
    for (let i = 0; i < 80; i += 1) {
      h.registry.handleControlFrame(mcpFrame(`req-${i}`), CLASSIFIER_SCOPE);
    }
    expect(h.registry.recentAudits().length).toBeLessThanOrEqual(64);
    expect(h.registry.recentAudits()[0]!.requestId).toBe('req-16');
  });
});

describe('PR-3: lease grant on explicit approval (§6.5)', () => {
  const NAVIGATE_TOOL = 'mcp__trylo-browser__browser_navigate';
  const lease: BrowserLeaseGrant = {
    kind: 'browser-origin',
    origin: 'https://docs.example.com',
    actionClass: 'navigate',
    conversationId: 'c1',
    ttlMs: 5 * 60 * 1000,
  };
  const promptWithLease: ToolRiskRouter = {
    serverNames: () => ['trylo-browser'],
    classify: (req) =>
      req.toolName === NAVIGATE_TOOL
        ? {
            behavior: 'prompt',
            risk: 'external',
            reasonCode: 'navigate_new_origin',
            preview: { kind: 'summary', title: '浏览器操作', target: 'https://docs.example.com', reason: '需审批' },
            lease,
            audit: {
              at: 1,
              profileId: 'work.core.v1',
              packageId: 'playwright',
              toolName: NAVIGATE_TOOL,
              behavior: 'prompt',
              risk: 'external',
              reasonCode: 'navigate_new_origin',
              inputDigest: 'feedbeef',
              pathZones: [],
            },
          }
        : { behavior: 'unmanaged' },
  };

  function navFrame(requestId: string): ControlFrame {
    return { kind: 'permission', requestId, toolName: NAVIGATE_TOOL, input: { url: 'https://docs.example.com/guide' } };
  }

  it('an approval records the lease via onLeaseGrant; a denial does not', async () => {
    const grants: ToolLeaseGrant[] = [];
    const h = createRegistry({ riskClassifier: promptWithLease, onLeaseGrant: (g) => grants.push(g) });
    h.registry.handleControlFrame(navFrame('req-nav'), CLASSIFIER_SCOPE);
    expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.list()[0]!.lease).toEqual(lease);

    await expect(h.registry.respond('req-nav', false)).resolves.toBe(true);
    expect(grants).toEqual([]);
  });

  it('an approval records the lease', async () => {
    const grants: ToolLeaseGrant[] = [];
    const h = createRegistry({ riskClassifier: promptWithLease, onLeaseGrant: (g) => grants.push(g) });
    h.registry.handleControlFrame(navFrame('req-nav'), CLASSIFIER_SCOPE);
    await expect(h.registry.respond('req-nav', true)).resolves.toBe(true);
    expect(grants).toEqual([lease]);
  });

  it('a broken lease sink never blocks the approval', async () => {
    const h = createRegistry({ riskClassifier: promptWithLease, onLeaseGrant: () => { throw new Error('sink bug'); } });
    h.registry.handleControlFrame(navFrame('req-nav'), CLASSIFIER_SCOPE);
    await expect(h.registry.respond('req-nav', true)).resolves.toBe(true);
    expect(h.registry.list()).toEqual([]);
  });
});

describe('WCC-P2-01: lease granted only after the response is delivered', () => {
  const NAVIGATE_TOOL = 'mcp__trylo-browser__browser_navigate';
  const lease: BrowserLeaseGrant = {
    kind: 'browser-origin',
    origin: 'https://docs.example.com',
    actionClass: 'navigate',
    conversationId: 'c1',
    ttlMs: 5 * 60 * 1000,
  };
  const promptWithLease: ToolRiskRouter = {
    serverNames: () => ['trylo-browser'],
    classify: (req) =>
      req.toolName === NAVIGATE_TOOL
        ? {
            behavior: 'prompt',
            risk: 'external',
            reasonCode: 'navigate_new_origin',
            preview: { kind: 'summary', title: '浏览器操作', target: 'https://docs.example.com', reason: '需审批' },
            lease,
            audit: {
              at: 1,
              profileId: 'work.core.v1',
              packageId: 'playwright',
              toolName: NAVIGATE_TOOL,
              behavior: 'prompt',
              risk: 'external',
              reasonCode: 'navigate_new_origin',
              inputDigest: 'feedbeef',
              pathZones: [],
            },
          }
        : { behavior: 'unmanaged' },
  };

  function navFrame(requestId: string): ControlFrame {
    return { kind: 'permission', requestId, toolName: NAVIGATE_TOOL, input: { url: 'https://docs.example.com/guide' } };
  }

  it('a FAILED send records NO lease (A-14: the write must precede the grant)', async () => {
    const grants: ToolLeaseGrant[] = [];
    const h = createRegistry({ riskClassifier: promptWithLease, onLeaseGrant: (g) => grants.push(g) });
    h.registry.handleControlFrame(navFrame('req-x'), CLASSIFIER_SCOPE);
    h.setFailSend(true);
    await expect(h.registry.respond('req-x', true)).resolves.toBe(false);
    expect(grants).toEqual([]);
    // The request is still pending; a retry after the write recovers grants
    // exactly once.
    h.setFailSend(false);
    await expect(h.registry.respond('req-x', true)).resolves.toBe(true);
    expect(grants).toEqual([lease]);
  });

  it('a retried respond after a successful send does not re-grant the lease (idempotent)', async () => {
    const grants: ToolLeaseGrant[] = [];
    const registry = new CodePermissionRegistry({
      onChange: () => {},
      send: async () => true,
      riskClassifier: promptWithLease,
      onLeaseGrant: (g) => grants.push(g),
    });
    registry.handleControlFrame(navFrame('req-y'), CLASSIFIER_SCOPE);
    await expect(registry.respond('req-y', true)).resolves.toBe(true);
    expect(grants).toEqual([lease]);
    // The pending entry is gone, so a second respond resolves false and the
    // same requestId can never mint a second grant.
    await expect(registry.respond('req-y', true)).resolves.toBe(false);
    expect(grants).toEqual([lease]);
  });

  it('a denial never grants the lease, even after a successful send', async () => {
    const grants: ToolLeaseGrant[] = [];
    const h = createRegistry({ riskClassifier: promptWithLease, onLeaseGrant: (g) => grants.push(g) });
    h.registry.handleControlFrame(navFrame('req-n'), CLASSIFIER_SCOPE);
    await expect(h.registry.respond('req-n', false)).resolves.toBe(true);
    expect(grants).toEqual([]);
  });
});
