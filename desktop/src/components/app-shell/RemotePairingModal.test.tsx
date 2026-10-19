import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { RemotePairingModal } from './RemotePairingModal';
import { EMPTY_REMOTE_STATUS } from '../../remote/remote-port';
import { remoteSettingsDefaults } from '../../settings/settings-store';
import type { RemotePairingInfoResult } from '../../services-host/methods';

const pairingDetails: RemotePairingInfoResult['pairing'] = {
  protocol: 1, service: 'trylo-remote', deviceId: 'fixture-device',
  deviceName: 'Fixture', workspaceName: 'Fixture workspace',
  baseUrl: 'https://fixture.invalid', token: 'fixture-pairing-token',
};

afterEach(cleanup);

it('accepts a recovered QR when React still has the pre-startup stopped status', async () => {
  const controller = { status: () => ({ ...EMPTY_REMOTE_STATUS, running: true }),
    pairing: vi.fn(async () => ({ pairing: pairingDetails, qrDataUrl: 'data:image/png;base64,authoritative' })) };
  render(<RemotePairingModal open remoteEnabled remoteStatus={EMPTY_REMOTE_STATUS} remoteController={controller} onClose={vi.fn()}/>);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'data:image/png;base64,authoritative');
  expect(screen.queryByText('远程服务已断开，请重试启动。')).not.toBeInTheDocument();
});

it('logs in and connects from the remote dialog without persisting the password', async () => {
  const account = { loggedIn: true, username: 'alice', serverUrl: 'https://relay.trylocode.me', online: false };
  const controller = { pairing: vi.fn(), relayStatus: vi.fn(async () => ({ ...account, loggedIn: false })), relayLogin: vi.fn(async () => account) };
  const onConfigure = vi.fn(async () => {});
  render(<RemotePairingModal open remoteController={controller} remoteSettings={{ ...remoteSettingsDefaults(), connectionMode: 'server' }} onConfigure={onConfigure} onClose={vi.fn()}/>);
  fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '登录并连接' }));
  await vi.waitFor(() => expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, connectionMode: 'server' })));
  expect(JSON.stringify(onConfigure.mock.calls)).not.toContain('fixture-password-123');
});

it('asks before switching a live connection and saves only the selected mode', async () => {
  const controller = { pairing: vi.fn(async () => ({ pairing: pairingDetails, qrDataUrl: 'qr' })) };
  const onConfigure = vi.fn(async () => {});
  render(<RemotePairingModal open remoteEnabled remoteController={controller} remoteSettings={{ ...remoteSettingsDefaults(), connectionMode: 'server' }} remoteStatus={{ ...EMPTY_REMOTE_STATUS, running: true }} onConfigure={onConfigure} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole('tab', { name: '独立隧道' }));
  expect(onConfigure).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await vi.waitFor(() => expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ connectionMode: 'tunnel', enabled: false })));
});

it('offers a real startup retry after failure and displays the recovered QR', async () => {
  let resolve!: (info: RemotePairingInfoResult) => void;
  const pairing = vi.fn().mockRejectedValueOnce(new Error('远程服务启动失败：host script not found'))
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const props = { open: true, remoteEnabled: true, remoteController: { pairing }, onClose: vi.fn() };
  const { rerender } = render(<RemotePairingModal {...props} remoteStatus={EMPTY_REMOTE_STATUS} />);
  expect(await screen.findByText('远程服务启动失败：host script not found')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '重试启动并生成二维码' }));
  rerender(<RemotePairingModal {...props} remoteStatus={{ ...EMPTY_REMOTE_STATUS, running: true }} />);
  await act(async () => resolve({ pairing: pairingDetails, qrDataUrl: 'data:image/png;base64,test' }));
  expect(await screen.findByAltText('配对二维码 — 用手机扫码连接')).toBeVisible();
  expect(pairing).toHaveBeenCalledTimes(2);
});

it('a user retry can restart the gateway and still display the new QR', async () => {
  let resolve!: (info: RemotePairingInfoResult) => void;
  const controller = { pairing: vi.fn(() => new Promise<RemotePairingInfoResult>(done => { resolve = done; })) };
  const props = { open: true, remoteEnabled: true, remoteController: controller, onClose: vi.fn() };
  const { rerender } = render(<RemotePairingModal {...props} remoteStatus={{ ...EMPTY_REMOTE_STATUS, running: true }} />);
  rerender(<RemotePairingModal {...props} remoteStatus={EMPTY_REMOTE_STATUS} />);
  rerender(<RemotePairingModal {...props} remoteStatus={{ ...EMPTY_REMOTE_STATUS, running: true }} />);
  await act(async () => resolve({ pairing: pairingDetails, qrDataUrl: 'data:image/png;base64,recovered' }));
  expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,recovered');
});

it('rejects empty QR data and ignores a late result after closing', async () => {
  let resolve!: (info: RemotePairingInfoResult) => void;
  const controller = { pairing: vi.fn(() => new Promise<RemotePairingInfoResult>((done) => { resolve = done; })) };
  const { rerender } = render(<RemotePairingModal open remoteEnabled remoteController={controller} onClose={vi.fn()} />);
  rerender(<RemotePairingModal open={false} remoteEnabled remoteController={controller} onClose={vi.fn()} />);
  await act(async () => resolve({ pairing: pairingDetails, qrDataUrl: 'old-qr' }));
  controller.pairing.mockResolvedValueOnce({ pairing: pairingDetails, qrDataUrl: '' });
  rerender(<RemotePairingModal open remoteEnabled remoteController={controller} onClose={vi.fn()} />);
  expect(await screen.findByText('配对二维码生成失败，请重试。')).toBeVisible();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('invalidates an in-flight QR when the gateway stops', async () => {
  let resolve!: (info: RemotePairingInfoResult) => void;
  const controller = { pairing: vi.fn(() => new Promise<RemotePairingInfoResult>((done) => { resolve = done; })) };
  const props = { open: true, remoteEnabled: true, remoteController: controller, onClose: vi.fn() };
  const { rerender } = render(<RemotePairingModal {...props} remoteStatus={{ ...EMPTY_REMOTE_STATUS, running: true }} />);
  rerender(<RemotePairingModal {...props} remoteStatus={EMPTY_REMOTE_STATUS} />);
  await act(async () => resolve({ pairing: pairingDetails, qrDataUrl: 'stale-qr' }));
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('远程服务已断开，请重试启动。')).toBeVisible();
});

it('automatically regenerates QR after the relay reconnects without reopening the panel', async () => {
  const pairing = vi.fn().mockResolvedValueOnce({ pairing: pairingDetails, qrDataUrl: 'first-qr' })
    .mockResolvedValueOnce({ pairing: pairingDetails, qrDataUrl: 'recovered-qr' });
  const props = { open: true, remoteEnabled: true, remoteController: { pairing }, onClose: vi.fn() };
  const online = { ...EMPTY_REMOTE_STATUS, running: true, connectionMode: 'server' as const };
  const { rerender } = render(<RemotePairingModal {...props} remoteStatus={online} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'first-qr');
  rerender(<RemotePairingModal {...props} remoteStatus={{ ...online, running: false, reasonCode: 'relay_reconnecting' }} />);
  expect(screen.getByText('服务器连接中断，正在重连')).toBeVisible();
  expect(screen.queryByText('远程服务启动失败')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  rerender(<RemotePairingModal {...props} remoteStatus={online} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'recovered-qr');
  expect(pairing).toHaveBeenCalledTimes(2);
});

it('recovers when the old QR request fails after the relay is already online again', async () => {
  let reject!: (error: Error) => void;
  const pairing = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValueOnce({ pairing: pairingDetails, qrDataUrl: 'fresh-after-recovery' });
  const props = { open: true, remoteEnabled: true, remoteController: { pairing }, onClose: vi.fn() };
  const online = { ...EMPTY_REMOTE_STATUS, running: true, connectionMode: 'server' as const };
  const { rerender } = render(<RemotePairingModal {...props} remoteStatus={online} />);
  rerender(<RemotePairingModal {...props} remoteStatus={{ ...online, running: false, reasonCode: 'relay_reconnecting' }} />);
  rerender(<RemotePairingModal {...props} remoteStatus={online} />);
  await act(async () => reject(new Error('连接已变化，请重新生成二维码。')));
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'fresh-after-recovery');
  expect(pairing).toHaveBeenCalledTimes(2);
});
