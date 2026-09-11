import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { UserLearningPanel, type UserLearningPanelProps } from './UserLearningPanel';
import type { LearningPort } from '../../learning/learning-port';
import type { UserLearningSnapshot, UserLearningSettings } from '../../user-learning/types';
import { filterEvidence, evidenceSurface } from './inspector-prefs';
import type { EvidenceRecord } from '../../user-learning/types';

afterEach(() => { cleanup(); localStorage.clear(); });

const EMPTY_SNAPSHOT = {
  schemaVersion: 2,
  userId: 'u1',
  traces: [],
  evidence: [],
  evidenceRelations: [],
  conclusions: [],
  conclusionRelations: [],
  profileFacts: [],
  userModels: [],
  userModelDerivations: [],
  projectContexts: [],
  policyRules: [],
  policyBundles: [],
  policyDecisions: [],
  cognitionSessions: [],
  cognitionCooldowns: [],
  learningRuns: [],
  dirtyDimensions: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as UserLearningSnapshot;

const SETTINGS: UserLearningSettings = {
  enabled: true,
  defaultMode: 'shadow',
  dimensionMode: {},
  cognitionEnabled: true,
};

function fakePort(over: Record<string, unknown> = {}): LearningPort {
  return {
    listPending: vi.fn(async () => ({
      ok: true,
      pending: [
        { id: 'p1', subsystem: 'skills', action: 'create', summary: 'a staged skill', origin: 'foreground', created_at: 1787994502 },
      ],
      count: 1,
    })),
    pendingDetail: vi.fn(async () => ({ ok: true, detail: { item: { id: 'p1' } } })),
    applyPending: vi.fn(async () => ({ ok: true })),
    discardPending: vi.fn(async () => ({ ok: true })),
    memorySnapshot: vi.fn(async () => ({ ok: true, snapshot: { memoryBlock: '', userBlock: '' } })),
    skills: vi.fn(async () => ({ ok: true, skills: [] })),
    ...over,
  } as unknown as LearningPort;
}

function renderPanel(port: LearningPort = fakePort(), opts: Readonly<Partial<UserLearningPanelProps>> = {}) {
  return render(
    <UserLearningPanel
      open
      snapshot={EMPTY_SNAPSHOT}
      settings={SETTINGS}
      learningPort={port}
      onClose={vi.fn()}
      onSettingsChange={vi.fn()}
      openedFrom="code"
      {...opts}
    />,
  );
}

// A minimal, valid EvidenceRecord factory for the virtuo list.
let seq = 0;
function ev(over: Partial<EvidenceRecord> & { product: 'code' | 'work' }): EvidenceRecord {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: 'u1',
    source: { sessionId: 's', taskId: 't', turnIds: [], actionIds: [], sourceHash: `h${seq}`, traceId: 'tr' },
    origin: { channel: 'interaction', eventType: 'approval', stage: 'post_execution' },
    rawObservation: { text: `raw ${seq}` },
    inference: { claim: `claim ${seq}`, semanticConfidence: 0.8, engineeringRelevance: 0.6 },
    context: { workspaceId: 'w', projectId: 'p', scopeTags: [], product: over.product },
    strength: { contextInformedness: 'task_context', band: 'medium' },
    governance: { level: 2, userLocked: false },
    createdAt: 1000 + seq,
    ...over,
  };
}

describe('UserLearningPanel', () => {
  it('opens from a surface into 用户认知 + that surface, not an empty agent queue', async () => {
    renderPanel(undefined, { openedFrom: 'work' });
    expect(screen.getByRole('button', { name: /用户认知/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /代理学习/ })).toBeTruthy();
    // Default module is 用户认知 → no staged queue rendered.
    expect(screen.queryByText('a staged skill')).toBeNull();
    // Work surface default → Work 三维度 coverage shown.
    expect(await screen.findByText(/Work 三维度/)).toBeTruthy();
  });

  it('switches to User Cognition and shows the Evidence→Policy shadow tabs', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Policy' })).toBeTruthy();
  });

  it('Agent Learning has a 已批准记录 sub-tab showing committed memory/skills', async () => {
    const port = fakePort({
      memorySnapshot: vi.fn(async () => ({
        ok: true,
        snapshot: { memoryBlock: '- remembered fact', userBlock: '' },
      })),
      skills: vi.fn(async () => ({
        ok: true,
        skills: [{ name: 'demo-skill', category: 'misc', description: 'a done skill' }],
      })),
    });
    renderPanel(port, { openedFrom: undefined });
    fireEvent.click(screen.getByRole('button', { name: /代理学习/ }));
    fireEvent.click(screen.getByRole('button', { name: '已批准记录' }));
    expect(await screen.findByText(/- remembered fact/)).toBeTruthy();
    expect(screen.getByText('demo-skill')).toBeTruthy();
  });

  it('the pending queue stays mounted while switching modules, so the badge survives', async () => {
    const port = fakePort();
    renderPanel(port, { openedFrom: undefined });
    // Switch to 代理学习 to mount the staged queue.
    fireEvent.click(screen.getByRole('button', { name: /代理学习/ }));
    await waitFor(() => expect(port.listPending).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /用户认知/ }));
    expect(screen.getByRole('button', { name: /代理学习/ }).textContent).toContain('1');
    expect(port.listPending).toHaveBeenCalledTimes(1);
  });

  it('shows Chinese dimension labels and surfaces the surface filter chips on Evidence', async () => {
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      evidence: [
        ev({ product: 'code', inference: { claim: '之后也要验证', semanticConfidence: 0.8, engineeringRelevance: 0.6 } }),
        ev({ product: 'work', inference: { claim: '这个周报很好', semanticConfidence: 0.8, engineeringRelevance: 0.6 } }),
      ],
    } as unknown as UserLearningSnapshot;
    renderPanel(fakePort(), { snapshot });
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.getAllByRole('button', { name: '全部' }).length).toBeGreaterThan(0);
    expect(screen.getByText('验证与审核')).toBeTruthy(); // dimensionLabel(verification_audit) via inferDimension
  });

  it('filterEvidence applies surface + strength filters and dates desc', () => {
    const a = ev({ product: 'code', createdAt: 1000, strength: { contextInformedness: 'task_context', band: 'weak' } });
    const b = ev({ product: 'work', createdAt: 3000, strength: { contextInformedness: 'task_context', band: 'strong' } });
    const c = ev({ product: 'work', createdAt: 2000, strength: { contextInformedness: 'task_context', band: 'strong' } });
    const r = filterEvidence([a, b, c], { surfaceFilter: 'work', channelFilter: 'all', dimensionFilter: 'all', strengthFilter: 'all' });
    expect(r.map((x) => x.id)).toEqual([b.id, c.id]);
    expect(r.map((x) => evidenceSurface(x))).toEqual(['work', 'work']);
  });
});