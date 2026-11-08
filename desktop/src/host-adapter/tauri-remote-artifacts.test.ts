import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./tauri-detect', () => ({ isTauri: mocks.native }));
import { tauriFsCommands } from './tauri-fs-commands';

describe('remote artifact host boundary', () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.native.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fails closed without the native host, without calling the browser filesystem or generic commands', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); mocks.native.mockReturnValue(false);
    await expect(tauriFsCommands.readRemoteArtifact!('D:/workspace', 'report.txt')).rejects.toThrow('native host');
    await expect(tauriFsCommands.listRemoteArtifacts!('D:/workspace')).rejects.toThrow('native host');
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('uses the dedicated native reader with separate workspace and relative path arguments', async () => {
    mocks.native.mockReturnValue(true); mocks.invoke.mockResolvedValue([1, 2, 255]);
    expect(await tauriFsCommands.readRemoteArtifact!('D:/workspace', 'nested/report.txt')).toEqual(Uint8Array.from([1, 2, 255]));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('read_remote_artifact', { workspaceRoot: 'D:/workspace', relativePath: 'nested/report.txt' });
  });

  it('obtains metadata exclusively from the bounded native listing command', async () => {
    const metadata = [{ relativePath: 'nested/report.txt', size: 6, modifiedMs: 1 }];
    mocks.native.mockReturnValue(true); mocks.invoke.mockResolvedValue(metadata);
    expect(await tauriFsCommands.listRemoteArtifacts!('D:/workspace')).toEqual(metadata);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('list_remote_artifacts', { workspaceRoot: 'D:/workspace' });
  });
});
