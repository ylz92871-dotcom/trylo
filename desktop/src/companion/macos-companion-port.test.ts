import { beforeEach, expect, it, vi } from 'vitest';
import { ServiceManager } from '../services-host/service-manager';
import { MacosCompanionPort } from './macos-companion-port';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset().mockResolvedValue(true));

it('shows the native window independently of the host, projecting approval and task state without request details', async () => {
  const host = vi.fn();
  const port = new MacosCompanionPort(
    new ServiceManager({ invoke: host, listen: async () => () => {} }),
    async () => ({ sidecarsDir: '', appDataDir: '' }),
    () => '',
  );

  expect(await port.start()).toMatchObject({ enabled: true, launched: true });
  expect(host).not.toHaveBeenCalled();
  await port.publish({ type: 'agentState', state: 'writing_files', detail: 'private path' });
  expect(invoke).toHaveBeenLastCalledWith('macos_companion_publish', { display: 'running' });

  await port.publish({ type: 'permissionRequestState', requests: [
    { requestId: 'private request', title: 'private title', approvalState: 'pending' },
  ] });
  expect(invoke).toHaveBeenLastCalledWith('macos_companion_publish', { display: 'waiting' });
  await port.publish({ type: 'permissionRequestState', requests: [] });
  expect(invoke).toHaveBeenLastCalledWith('macos_companion_publish', { display: 'running' });

  await port.stop();
  expect(invoke).toHaveBeenLastCalledWith('macos_companion_window', { action: 'hide' });
  await port.publish({ type: 'assistant' });
  expect(invoke).toHaveBeenLastCalledWith('macos_companion_window', { action: 'hide' });
});
