import { expect, it } from 'vitest';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import { bindConversationPageLifecycle } from './conversation-page-lifecycle';

it.each(['native', 'browser'] as const)('pagehide preserves the process owner boundary in %s with two real roots', async host => {
  const processes = new NodeProcessFixture(process.env);
  const page = new EventTarget(); const errors: unknown[] = [];
  let finished!: () => void;
  const receipt = new Promise<void>(resolve => { finished = resolve; });
  let stopping = false;
  const detach = bindConversationPageLifecycle({ host, page, onStopError: error => errors.push(error),
    stopAll: async () => { stopping = true; try { await processes.dispose(); } finally { finished(); } } });
  try {
    for (const conversationId of ['visible', 'background']) {
      await processes.spawn({ command: process.execPath,
        args: ['-e', '/* conversation-page-owner-20261026 */ setInterval(()=>{},1000)'], label: 'trylo-cli-v1',
        metadata: { projectKey: 'D:/page-owner-proof', conversationId, runId: `run-${conversationId}` }, onOutput() {} });
    }
    page.dispatchEvent(new Event('pagehide'));
    if (stopping) await receipt;
    expect(processes.children.size).toBe(host === 'native' ? 2 : 0);
    expect((await processes.list()).length).toBe(host === 'native' ? 2 : 0);
    expect(errors).toEqual([]);
  } finally {
    detach(); await processes.dispose();
    expect(processes.children.size).toBe(0); expect(await processes.list()).toEqual([]);
  }
}, 10_000);
