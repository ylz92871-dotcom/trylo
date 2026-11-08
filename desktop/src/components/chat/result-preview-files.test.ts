import { describe, it, expect } from 'vitest';
import { codePreviewFiles, workPreviewFiles, codeReviewFiles, workReviewFiles } from './result-preview-files';
import type { StoredCodeChange } from '../../results/conversation-result-types';
const change = (path: string, kind: StoredCodeChange['kind'] = 'modified'): StoredCodeChange => ({ path, kind, staged: false, unstaged: true, untracked: false });
describe('delivery preview attribution', () => {
  it('keeps historical Work files in rail navigation without promoting them as new deliveries', () => {
    const artifacts = ['current.md', 'old.pdf', 'program.exe'].map(path => ({ id: path, displayName: path,
      target: { kind: 'file' as const, relativePath: path } }));
    expect(workReviewFiles({ artifacts }).map(file => file.path)).toEqual(['current.md', 'old.pdf']);
    expect(workPreviewFiles({ artifacts }).map(file => file.path)).toEqual([]);
  });
  it('navigates recorded Code text and workspace files without claiming run attribution', () => {
    const result = { attribution: 'workspace_only' as const, changes: [change('notes.txt'), change('old.pdf'), change('gone.md', 'deleted')],
      outputs: [{ path: 'notes.txt', change: 'created' as const, signature: { size: 1, modifiedMs: 1 } }] };
    expect(codeReviewFiles(result).map(file => file.path)).toEqual(['notes.txt', 'old.pdf']);
    expect(codePreviewFiles({ ...result, outputs: [] })).toEqual([]);
  });
  it('keeps old files and external-app targets out of Work preview buttons', () => {
    const artifacts = ['report.pdf', 'program.exe', 'plugin.jar', 'old.pdf'].map((path) => ({ id: path, target: { kind: 'file' as const, relativePath: path }, displayName: path }));
    expect(workPreviewFiles({ artifacts, latestRun: { createdIds: ['report.pdf', 'program.exe', 'plugin.jar'], updatedIds: [], discoveredIds: [] } })).toEqual([{ path: 'report.pdf', name: 'report.pdf' }, { path: 'plugin.jar', name: 'plugin.jar' }]);
  });
  it('does not promote existing workspace files into this run’s deliverables', () => {
    expect(codePreviewFiles({ attribution: 'workspace_only', changes: [change('old.pdf')] })).toEqual([]);
    expect(codePreviewFiles({ attribution: 'unavailable', changes: [change('old.pdf')] })).toEqual([]);
  });
  it('provides preview entries for live rich files in the run delta', () => {
    expect(codePreviewFiles({ attribution: 'run_delta', changes: [change('report.pdf'), change('index.ts'), change('removed.pptx', 'deleted'), change('part.sldprt')] })).toEqual([{ path: 'report.pdf' }, { path: 'index.ts' }]);
  });
  it('includes new readers in Work deliveries while excluding historical and deleted Code outputs', () => {
    const paths = ['clip.mkv', 'sound.flac', 'analysis.ipynb', 'font.woff2', 'source.7z', 'bundle.jar', 'old.ipynb'];
    const artifacts = paths.map((path) => ({ id: path, displayName: path, target: { kind: 'file' as const, relativePath: path } }));
    const current = paths.slice(0, -1);
    expect(workPreviewFiles({ artifacts, latestRun: { createdIds: current, updatedIds: [], discoveredIds: [] } }).map((file) => file.path)).toEqual(current);
    expect(codePreviewFiles({ attribution: 'run_delta', changes: current.map((path) => change(path)).concat(change('removed.zip', 'deleted')) }).map((file) => file.path)).toEqual(current);
  });
});
