import { describe, expect, it } from 'vitest';
import type { FileChangeEvent } from '../../host-adapter/types';
import { mergeOutputEvidence, watchOutputFiles } from './watch';
import { CodeResultProjector } from '../code-result-projector';
import { WorkResultProjector } from '../work-result-projector';
import type { StoredCodeRunResult } from '../conversation-result-types';

function fixture() {
  let callback: (events: readonly FileChangeEvent[]) => void = () => {};
  let closed = 0;
  const watcher = { watch: () => ({ ready: Promise.resolve(), onDidChangeFile: (_path: string, cb: typeof callback) => { callback = cb; return () => { callback = () => {}; }; }, close: async () => { closed += 1; } }), close: async () => {} };
  const fs = { statFile: async (path: string) => ({ path, size: 12, modifiedMs: 2, isFile: !path.endsWith('link.pdf'), isDirectory: false, isSymlink: path.endsWith('link.pdf') }) };
  return { watcher, fs, emit: (events: FileChangeEvent[]) => callback(events), closed: () => closed };
}

describe('live output file evidence', () => {
  it('collects source, extensionless and previously unknown deliverables without a format whitelist', async () => {
    const f = fixture(); const watch = watchOutputFiles('D:/repo', f.watcher, f.fs);
    await watch.ready;
    const names = ['main.py', 'component.tsx', 'Dockerfile', 'result.custom-language', 'clip.mkv'];
    f.emit(names.map((path) => ({ kind: 'created', path: `D:/repo/${path}` })));
    expect((await watch.finish()).files.map((file) => file.path)).toEqual(names);
  });
  it('keeps ignored/root/nested outputs while excluding runtime/dependency files and symlinks', async () => {
    const f = fixture();
    const watch = watchOutputFiles('D:/repo', f.watcher, f.fs);
    await watch.ready;
    f.emit(['ignored/report.pdf', 'out/chart.png', '.trylo/out/data.csv', 'node_modules/report.pdf', '.trylo/attachments/input.pdf', 'link.pdf'].map((path) => ({ kind: 'created', path: `D:/repo/${path}` })));
    f.emit([{ kind: 'modified', path: 'D:/repo/ignored/report.pdf' }]);
    const result = await watch.finish();
    expect(result.files.map((file) => file.path).sort()).toEqual(['.trylo/out/data.csv', 'ignored/report.pdf', 'out/chart.png']);
    expect(result.files.every((file) => file.change === 'created')).toBe(true);
    expect(result.incomplete).toBe(false); expect(f.closed()).toBe(1);
  });
  it('marks dropped notifications as partial, and closes only its own subscription', async () => {
    const f = fixture(); const watch = watchOutputFiles('D:/repo', f.watcher, f.fs);
    await watch.ready;
    f.emit([{ kind: 'rescan', path: 'D:/repo' }]);
    expect((await watch.finish()).incomplete).toBe(true);
    watch.close(); expect(f.closed()).toBe(1);
  });
  it('a complete live watch repairs a truncated scan without pretending unknown baseline files are new', () => {
    expect(mergeOutputEvidence({ files: [], incomplete: true }, { files: [{ path: 'new.pdf', change: 'created', signature: { size: 12, modifiedMs: 2 } }], incomplete: false }).incomplete).toBe(false);
  });
  it('collects a shell output after a large baseline was truncated', async () => {
    const f = fixture(); const writes: StoredCodeRunResult[] = [];
    const projector = new CodeResultProjector({
      outputWatch: (root) => watchOutputFiles(root, f.watcher, f.fs),
      outputSnapshot: async () => ({ files: [], incomplete: true }),
      git: { snapshot: async () => ({ repository: true, head: 'head', entries: [], capturedAt: 0, truncated: false }), fileDiff: async () => { throw new Error('unused'); }, diffStats: async () => [] },
      store: { update: (_p, _r, _c, result) => { if (result) writes.push(result); } },
    });
    const scope = { projectKey: 'p', projectRoot: 'D:/repo', conversationId: 'c', mode: 'code' as const, runId: 'r', turnId: 't', startedAt: 1 };
    await projector.onRunStarted(scope);
    f.emit([{ kind: 'created', path: 'D:/repo/ignored/shell.pdf' }]);
    await projector.onRunTerminal(scope, 'completed');
    expect(writes[0]?.outputs?.[0]?.path).toBe('ignored/shell.pdf');
    expect(writes[0]?.outputsIncomplete).toBe(false);
    expect(writes[0]?.meta.status).toBe('completed');
  });
  it('collects a Work shell output from live evidence when both scans are partial', async () => {
    const f = fixture(); const writes: import('../conversation-result-types').StoredWorkResult[] = [];
    const projector = new WorkResultProjector({
      outputWatch: (root) => watchOutputFiles(root, f.watcher, f.fs),
      outputSnapshot: async () => ({ files: [], incomplete: true }),
      scan: async () => ({ artifacts: [], truncated: true }),
      port: { update: (_p, _r, _c, result) => { if (result) writes.push(result); } },
    });
    const scope = { projectKey: 'p', projectRoot: 'D:/repo', conversationId: 'c', taskId: 'task', runId: 'r', turnId: 't', startedAt: 1 };
    await projector.onRunStarted(scope);
    f.emit([{ kind: 'created', path: 'D:/repo/export/report.pdf' }]);
    await projector.onRunTerminal(scope, 'cancelled');
    expect(writes.at(-1)?.artifacts.map((file) => file.id)).toEqual(['export/report.pdf']);
    expect(writes.at(-1)?.latestRun?.createdIds).toEqual(['export/report.pdf']);
    expect(writes.at(-1)?.latestRun?.status).toBe('cancelled');
  });
});
