import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertNativeDialog, confirmNativeDialog } from './native-dialog';

const dialogMocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: dialogMocks.ask,
  message: dialogMocks.message,
}));

function setTauriGlobal(enabled: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (enabled) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriGlobal(false);
});

afterEach(() => {
  setTauriGlobal(false);
  vi.restoreAllMocks();
});

describe('native-dialog bridge', () => {
  it('uses @tauri-apps/plugin-dialog ask and message inside Tauri', async () => {
    setTauriGlobal(true);
    dialogMocks.ask.mockResolvedValueOnce(true);
    dialogMocks.message.mockResolvedValueOnce(undefined);

    const ok = await confirmNativeDialog({
      title: '删除数据',
      message: '确认删除？',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消',
    });
    expect(ok).toBe(true);
    expect(dialogMocks.ask).toHaveBeenCalledWith('确认删除？', {
      title: '删除数据',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消',
    });

    await alertNativeDialog({ title: '错误', message: '操作失败', kind: 'error' });
    expect(dialogMocks.message).toHaveBeenCalledWith('操作失败', {
      title: '错误',
      kind: 'error',
    });
  });

  it('falls back cleanly to window.confirm and window.alert outside Tauri', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(confirmNativeDialog({ message: 'Delete?' })).resolves.toBe(false);
    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(dialogMocks.ask).not.toHaveBeenCalled();

    await alertNativeDialog({ message: 'Failed!' });
    expect(alertSpy).toHaveBeenCalledWith('Failed!');
    expect(dialogMocks.message).not.toHaveBeenCalled();
  });
});
