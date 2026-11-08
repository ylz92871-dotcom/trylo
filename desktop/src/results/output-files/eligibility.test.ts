import { describe, expect, it, vi } from 'vitest';
import { outputRelativePath, snapshotOutputFiles } from './snapshot';
import { artifactFromStat } from '../work-artifact-scanner';
import { targetFromInput } from '../artifact-record';
import { watchOutputFiles } from './watch';
import { isOutputArtifactPath } from './eligibility';
import type { FileChangeEvent } from '../../host-adapter/types';

const ROOT = 'D:/project';
const PROFILE_PATHS = [
  'viewport-profile-812-1794140000000/Default/LOCK',
  'browser/Trylo.exe.WebView2/EBWebView/Default/declarative_performance_observer.db-journal',
  'cache/preview/web/browser-artifact-preview-812-2/Default/LOG',
  `data/native-browser/${'a'.repeat(64)}/Default/DIPS`,
  'edge-profile/Default/declarative_performance_observer.db-journal',
  'edge-profile/Default/DIPS',
  'edge-profile/Default/Local Storage/leveldb/LOCK',
  'browser-profile/Default/LOG',
  'edge-profile/System Profile/Local Storage/leveldb/CURRENT',
  'browser-profile/ShaderCache/data_0',
  'edge-profile/Local State',
  'edge-profile/Last Version',
  'edge-profile/Variations',
  'edge-profile/VariationsRuntimeSeedV2',
  'edge-profile/VariationsSafeSeedV2',
  'edge-profile/VariationsSeedV2',
  'edge-profile/FirstLaunchAfterInstallation',
  'edge-profile/CrashpadMetrics-active.pma',
  'browser-profile/DevToolsActivePort',
];

describe('output eligibility at every ingestion path', () => {
  it.each(PROFILE_PATHS)('does not collect managed profile %s from a workspace snapshot', path => {
    expect(outputRelativePath(ROOT, `${ROOT}/${path}`)).toBeNull();
  });

  it.each(PROFILE_PATHS)('does not turn managed profile %s into a scanned artifact', path => {
    expect(artifactFromStat({ path: `${ROOT}/${path}`, size: 20, modifiedMs: 2 }, ROOT)).toBeUndefined();
  });

  it.each(PROFILE_PATHS)('does not turn managed profile %s into an event artifact', path => {
    expect(targetFromInput(`${ROOT}/${path}`, ROOT)).toBeUndefined();
  });

  it.each([
    'browser/LOCK', 'Default/DIPS', 'Default/Network/Cookies', 'logs/LOG', 'out/CURRENT', '.trylo/out/LOCK',
    'reports/declarative_performance_observer.db-journal', 'data/MANIFEST-000001',
    'native-browser/not-a-scope/LOG', 'preview/web/documentation/report.md',
    'viewport-profile-user-guide/notes.md', 'Browser.WebView2/notes.md',
    '.playwright-mcp/screenshot.png', '.trylo/out/report.pdf', 'Dockerfile',
    'edge-profile/report.pdf', 'browser-profile/screenshot.png', 'browser/Default/report.pdf',
    'Default/report.pdf', 'edge-profile/documentation/report.pdf',
    'edge-profile/README.md', 'browser-profile/README', 'reports/Local State',
    'browser/DevToolsActivePort', 'browser-profile/Variations-analysis.pdf',
  ])('keeps an ordinary output named %s', path => {
    expect(outputRelativePath(ROOT, `${ROOT}/${path}`)).toBe(path);
    expect(artifactFromStat({ path: `${ROOT}/${path}`, size: 20, modifiedMs: 2 }, ROOT)).toBeDefined();
    expect(targetFromInput(`${ROOT}/${path}`, ROOT)).toBeDefined();
  });

  it('uses the same policy for snapshot results returned by the host', async () => {
    const scanTree = vi.fn(async () => ({
      files: [...PROFILE_PATHS, 'export/screenshot.png'].map(path => ({
        path: `${ROOT}/${path}`, size: 20, modifiedMs: 2,
        isFile: true, isDirectory: false, isSymlink: false,
      })),
      truncated: false,
      warnings: [],
    }));
    const result = await snapshotOutputFiles(ROOT, { scanTree });
    expect(result.files.map(file => file.path)).toEqual(['export/screenshot.png']);
    expect(result.incomplete).toBe(false);
  });

  it('uses the same policy before live events enter the produced-file map', async () => {
    let receive: (events: readonly FileChangeEvent[]) => void = () => {};
    const watcher = {
      watch: () => ({
        onDidChangeFile: (_root: string, callback: typeof receive) => {
          receive = callback;
          return () => {};
        },
        close: async () => {},
      }),
      close: async () => {},
    };
    const statFile = vi.fn(async (path: string) => ({
      path, size: 20, modifiedMs: 2, isFile: true, isDirectory: false, isSymlink: false,
    }));
    const watch = watchOutputFiles(ROOT, watcher, { statFile });
    await watch.ready;
    receive([...PROFILE_PATHS, '.playwright-mcp/screenshot.png'].map(path => ({
      path: `${ROOT}/${path}`, kind: 'created',
    })));
    const result = await watch.finish();
    expect(result.files.map(file => file.path)).toEqual(['.playwright-mcp/screenshot.png']);
    expect(statFile).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing runtime, dependency and relative-path boundaries', () => {
    for (const path of ['.trylo/runtime/browser/c/a.png', '.trylo/attachments/a.pdf', 'node_modules/a.pdf',
      'loop-trylo-run.jsonl', '../report.pdf', '/report.pdf', 'D:/report.pdf']) {
      expect(isOutputArtifactPath(path)).toBe(false);
    }
    expect(isOutputArtifactPath('VIEWPORT-PROFILE-812-1794140000000\\Default\\LOCK')).toBe(false);
    expect(isOutputArtifactPath('out/report.custom-format')).toBe(true);
    expect(targetFromInput('https://example.com/report', ROOT)?.target.kind).toBe('url');
  });
});
