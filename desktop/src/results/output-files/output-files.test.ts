import { describe, expect, it, vi } from 'vitest';
import { outputFileDelta } from './delta';
import { snapshotOutputFiles, outputRelativePath, type OutputSnapshot } from './snapshot';
import { CodeResultProjector } from '../code-result-projector';
import type { StoredCodeRunResult } from '../conversation-result-types';
import { normalizeConversationResults } from '../conversation-result-normalizer';
import { codePreviewFiles } from '../../components/chat/result-preview-files';
import type { FsCommands } from '../../host-adapter/commands';
import { WorkResultProjector } from '../work-result-projector';
import type { StoredWorkResult } from '../conversation-result-types';
import { OutputRunOwnership } from './ownership';

const scope = { projectKey: 'p', projectRoot: 'D:/project', conversationId: 'c', mode: 'code' as const, runId: 'r', turnId: 't', startedAt: 1 };
const file = (path: string, modifiedMs = 1) => ({ path, signature: { size: 50, modifiedMs } });
const snapshot = (files: OutputSnapshot['files'], incomplete = false): OutputSnapshot => ({ files, incomplete });

describe('output file evidence', () => {
  it('discovers ignored/nested outputs without Git and excludes old/deleted files', () => {
    const result = outputFileDelta(snapshot([file('old.pdf'), file('updated.xlsx'), file('removed.png')]), snapshot([
      file('old.pdf'), file('updated.xlsx', 2), file('ignored/output/report.docx', 2),
    ]));
    expect(result.files.map((f) => [f.path, f.change])).toEqual([
      ['ignored/output/report.docx', 'created'], ['updated.xlsx', 'updated'],
    ]);
    expect(result.incomplete).toBe(false);
  });
  it('never treats failed or truncated baselines as proof that a file is new', () => {
    expect(outputFileDelta(null, snapshot([file('old.pdf')])).files).toEqual([]);
    const delta = outputFileDelta(snapshot([file('known.pdf')], true), snapshot([file('old.pdf'), file('known.pdf', 2)]));
    expect(delta.files.map((f) => f.path)).toEqual(['known.pdf']);
    expect(delta.incomplete).toBe(true);
  });
  it('rejects attachments, runtime files, traversal and sibling roots', () => {
    for (const path of ['D:/project/.trylo/attachments/a.pdf', 'D:/project/.trylo/history/a.json', 'D:/project/../a.pdf', 'D:/project-other/a.pdf']) {
      expect(outputRelativePath(scope.projectRoot, path)).toBeNull();
    }
    expect(outputRelativePath(scope.projectRoot, 'd:\\PROJECT\\.trylo\\out\\a.pdf')).toBe('.trylo/out/a.pdf');
    expect(outputRelativePath('/home/Project', '/home/project/a.pdf')).toBeNull();
  });
  it('requests host pruning and rejects non-regular files even from a faulty host', async () => {
    const stat = { size: 50, modifiedMs: 1, isFile: true, isDirectory: false, isSymlink: false };
    const scanTree = vi.fn<Parameters<FsCommands['scanTree']>, ReturnType<FsCommands['scanTree']>>(async () => ({ files: [
      { ...stat, path: 'D:/project/a.pdf' }, { ...stat, path: 'D:/project/link.pdf', isSymlink: true },
      { ...stat, path: 'D:/project/folder.pdf', isFile: false, isDirectory: true },
      { ...stat, path: 'D:/project/.trylo/attachments/a.pdf' },
    ], truncated: false, warnings: ['one unreadable folder'] }));
    const result = await snapshotOutputFiles(scope.projectRoot, { scanTree });
    expect(result.files.map((f) => f.path)).toEqual(['a.pdf']);
    expect(result.incomplete).toBe(true);
    expect(scanTree.mock.calls[0]?.[1]).toMatchObject({ excludeDirs: expect.arrayContaining(['node_modules', '.git']), maxFiles: 10_000 });
    expect(scanTree.mock.calls[0]?.[1]?.extensions).toBeUndefined();
  });
});

function projector(scan: () => Promise<OutputSnapshot>) {
  const writes: StoredCodeRunResult[] = [];
  const instance = new CodeResultProjector({
    outputSnapshot: scan,
    git: { snapshot: vi.fn(async () => ({ repository: false, entries: [], capturedAt: 0, truncated: false })), fileDiff: vi.fn(), diffStats: vi.fn(async () => []) },
    store: { update: (_p, _r, _c, result) => { if (result) writes.push(result); } },
  });
  return { instance, writes };
}

describe('run-scoped output lifecycle', () => {
  it('tracks overlapping Code/Work roots without inventing per-conversation ownership', () => {
    const ownership = new OutputRunOwnership();
    ownership.begin('code', scope);
    ownership.begin('work', { ...scope, projectRoot: 'd:\\PROJECT\\', conversationId: 'other' });
    expect(ownership.finish('code')).toBe(false);
    expect(ownership.finish('work')).toBe(false);
    ownership.begin('later', scope);
    expect(ownership.finish('later')).toBe(true);
  });
  it('collects Work shell outputs outside .trylo/out and never imports old files', async () => {
    const writes: StoredWorkResult[] = [];
    const outputSnapshot = vi.fn().mockResolvedValueOnce(snapshot([file('old.pdf')]))
      .mockResolvedValueOnce(snapshot([file('old.pdf'), file('export/report.docx', 2)]));
    const instance = new WorkResultProjector({ outputSnapshot, scan: async () => ({ artifacts: [], truncated: false }), port: { update: (_p, _r, _c, result) => { if (result) writes.push(result); } } });
    const workScope = { ...scope, taskId: 'task' };
    await instance.onRunStarted(workScope);
    await instance.onRunTerminal(workScope, 'completed');
    expect(writes[0]?.artifacts.map((a) => a.id)).toEqual(['export/report.docx']);
    expect(writes[0]?.latestRun?.createdIds).toEqual(['export/report.docx']);
  });
  it('persists and exposes a shell output with no tool write event or Git repository', async () => {
    const scan = vi.fn().mockResolvedValueOnce(snapshot([file('old.pdf')])).mockResolvedValueOnce(snapshot([file('old.pdf'), file('dist/report.pdf', 2)]));
    const { instance, writes } = projector(scan);
    instance.onRunStarted(scope);
    await instance.onRunTerminal(scope, 'completed');
    await instance.onRunTerminal(scope, 'completed');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.changes).toEqual([]);
    expect(codePreviewFiles(writes[0]!)).toEqual([{ path: 'dist/report.pdf' }]);
    const saved = normalizeConversationResults({ schemaVersion: 1, code: { latestRun: writes[0] } });
    expect(saved?.code?.latestRun?.outputs).toEqual(writes[0]?.outputs);
  });
  it('does not resurrect a deleted conversation while terminal scanning', async () => {
    let resolve!: (snapshot: OutputSnapshot) => void;
    const scan = vi.fn().mockResolvedValueOnce(snapshot([])).mockImplementationOnce(() => new Promise<OutputSnapshot>((r) => { resolve = r; }));
    const { instance, writes } = projector(scan);
    instance.onRunStarted(scope);
    const terminal = instance.onRunTerminal(scope, 'completed');
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    instance.clearConversation('p', 'c');
    resolve(snapshot([file('a.pdf')]));
    await terminal;
    expect(writes).toEqual([]);
  });
  it('drops a terminal that arrives only after the conversation has been cleared', async () => {
    const { instance, writes } = projector(async () => snapshot([]));
    instance.onRunStarted(scope);
    instance.clearConversation('p', 'c');
    await instance.onRunTerminal(scope, 'completed');
    expect(writes).toEqual([]);
  });
  it('discards an older run terminal after a newer run has started', async () => {
    const { instance, writes } = projector(async () => snapshot([file('a.pdf')]));
    instance.onRunStarted(scope);
    instance.onRunStarted({ ...scope, runId: 'newer', startedAt: 2 });
    await instance.onRunTerminal(scope, 'completed');
    expect(writes).toEqual([]);
  });
  it('does not let an unstarted terminal borrow the active run ownership', async () => {
    const { instance, writes } = projector(async () => snapshot([]));
    instance.onRunStarted({ ...scope, runId: 'current' });
    await instance.onRunTerminal({ ...scope, runId: 'unstarted-old-replay' }, 'completed');
    expect(writes).toEqual([]);
    await instance.onRunTerminal({ ...scope, runId: 'current' }, 'completed');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.meta.runId).toBe('current');
  });
});
