import { describe, expect, it } from 'vitest';
import { resolveCodeToolPolicy } from './code-tool-policy';

describe('shell approval authority preview', () => {
  it('shows later commands, pipeline receiver, output file and background status', () => {
    for (const extra of [{ steps: ['node cleanup.js'] }, { pipeTo: 'node upload.js' }]) {
      const result = resolveCodeToolPolicy({ toolName: 'run_shell', permissionLevel: 'ask', projectRoot: 'D:/project', at: 1,
        input: { command: 'node report.js', ...extra, stdoutFile: 'report.json', runInBackground: true } }, { behavior: 'unmanaged' });
      expect(result.behavior).toBe('prompt');
      if (result.behavior !== 'prompt') return;
      const preview = JSON.stringify(result.preview);
      expect(preview).toContain('node report.js');
      expect(preview).toContain('steps' in extra ? 'node cleanup.js' : 'node upload.js');
      expect(preview).toContain('report.json');
      expect(preview).toContain('后台');
      expect(result.preview.reason).toContain('report.json');
      expect(result.preview.reason).toContain('后台');
    }
  });
});
