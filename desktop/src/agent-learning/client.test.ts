import { describe, expect, it } from 'vitest';
import { createAgentLearningClient, parseAgentLearningReply } from './client';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath } from '../host-adapter/types';

const entry = { domain: 'method', id: 'method-v1', versionId: 'method-v1', title: '保留零金额记录', summary: '先检查字段缺失',
  status: 'active_pool', source: 'inferred', scope: 'niche-report', content: { hint: '保留零金额记录' }, markdown: '# 保留零金额记录', raw: '{"hint":"保留零金额记录"}' };
const payload = (entries: unknown[] = [entry]) => JSON.stringify({ schemaVersion: 1, ok: true, domain: 'method', entries });

describe('agent learning read boundary', () => {
  it('rejects missing fields, wrong domains, duplicate identities and false empty success', () => {
    expect(parseAgentLearningReply(payload(), 'method')[0]?.source).toBe('inferred');
    for (const text of ['bad json', payload([entry, entry]), payload([{ ...entry, content: null }]), payload([{ ...entry, versionId: 'different' }]),
      JSON.stringify({ schemaVersion: 1, ok: false, reason: 'board_unavailable' })]) expect(() => parseAgentLearningReply(text, 'method')).toThrow();
    expect(() => parseAgentLearningReply(payload(), 'workflow')).toThrow();
  });
  it('uses the selected CLI and exact version identity, without any learning or approval flags', async () => {
    const calls: Parameters<ProcessService['spawn']>[0][] = [];
    const process: Pick<ProcessService, 'spawn' | 'stop'> = { async spawn(options) {
      calls.push(options);options.onOutput(payload());options.onExit?.({ id: 'read', pid: 1, code: 0, signal: null });
      return { id: 'read', pid: 1, label: options.label, command: options.command };
    }, stop: async () => {} };
    const client = createAgentLearningClient({ cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/reports' as FilePath, process });
    expect((await client.detail('method', 'method-v1', new AbortController().signal)).versionId).toBe('method-v1');
    expect(calls[0]?.args.slice(-4)).toEqual(['learn', 'inspect', 'method', 'method-v1']);
    expect(calls[0]?.cwd).toBe('D:/reports');
    await expect(client.detail('method', '--activate', new AbortController().signal)).rejects.toThrow('invalid_version_identity');
    expect(calls).toHaveLength(1);
  });
});
