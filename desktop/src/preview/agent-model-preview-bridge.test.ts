import { describe, expect, it } from 'vitest';
import { AgentModelPreviewBridge } from './agent-model-preview-bridge';
import type { AgentModelPreviewCommand } from './agent-model-preview-types';
import type { ModelPreviewController, ModelPreviewState } from '../components/preview/ModelPreview';

const command = (operation: AgentModelPreviewCommand['operation'], scope = 'a'): AgentModelPreviewCommand => ({
  id: `${scope}-${operation}`, bridgeId: 'bridge', scope, projectRoot: 'D:/project', conversationId: scope,
  operation, path: 'D:/project/model.glb', revision: 'sha-one',
});
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
function bind(bridge: AgentModelPreviewBridge, scope = 'a', revision = 'sha-one'): ModelPreviewController {
  const session = bridge.sessions().find(value => value.scope === scope)!;
  const state: ModelPreviewState = { status: 'ready', path: session.path, revision, version: 1, readyVersion: 1, wireframe: false };
  const controller: ModelPreviewController = {
    getState: () => state, reload: async () => state, waitUntilReady: async () => state,
    setCamera: () => {}, setWireframe: () => {},
    capture: async () => ({ path: state.path, revision: state.revision, version: state.version,
      width: 800, height: 600, mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      wireframe: false, camera: { position: [1, 2, 3], target: [0, 0, 0] } }),
  };
  bridge.bind(scope, session.key, controller);
  bridge.observe(scope, session.key, state);
  return controller;
}

describe('agent scene lifecycle', () => {
  it('waits for the exact opened revision and returns that rendered version', async () => {
    const bridge = new AgentModelPreviewBridge();
    const open = bridge.execute(command('open')); await flush();
    bind(bridge);
    expect(await open).toMatchObject({ status: 'ready', revision: 'sha-one' });
    expect(await bridge.execute(command('snapshot'))).toMatchObject({ revision: 'sha-one', mimeType: 'image/jpeg', version: 1 });
    bridge.dispose();
  });

  it('keeps independent scene bindings for background conversations', async () => {
    const bridge = new AgentModelPreviewBridge();
    const a = bridge.execute(command('open')); const b = bridge.execute(command('open', 'b')); await flush();
    bind(bridge, 'a'); bind(bridge, 'b'); await Promise.all([a, b]);
    bridge.close('b');
    expect(await bridge.execute(command('snapshot', 'a'))).toMatchObject({ revision: 'sha-one' });
    expect(bridge.sessions().map(scene => scene.scope)).toEqual(['a']);
    bridge.dispose();
  });

  it('invalidates an old capture if a file changes before its frame returns', async () => {
    const bridge = new AgentModelPreviewBridge();
    const opened = bridge.execute(command('open')); await flush();
    const controller = bind(bridge); await opened;
    let complete!: (value: Awaited<ReturnType<ModelPreviewController['capture']>>) => void;
    const frame = await controller.capture();
    controller.capture = () => new Promise(resolve => { complete = resolve; });
    const capture = bridge.execute(command('snapshot')); const rejected = expect(capture).rejects.toThrow('旧画面'); await flush();
    bridge.changed({ ...command('open'), path: command('open').path!, revision: 'sha-two' });
    complete(frame); await rejected;
    bridge.dispose();
  });

  it('close preempts a loading scene rather than waiting for its parser', async () => {
    const bridge = new AgentModelPreviewBridge();
    const opened = bridge.execute(command('open')); const rejected = expect(opened).rejects.toThrow('已关闭'); await flush();
    expect(await bridge.execute(command('close'))).toEqual({ closed: true });
    await rejected;
    expect(bridge.sessions()).toEqual([]);
  });

  it('cancelled snapshot releases its queue even when an old renderer never responds', async () => {
    const bridge = new AgentModelPreviewBridge();
    const opened = bridge.execute(command('open')); await flush();
    const controller = bind(bridge); await opened;
    controller.capture = () => new Promise(() => {});
    const snapshot = bridge.execute(command('snapshot')); const cancelled = expect(snapshot).rejects.toThrow('取消'); await flush();
    bridge.cancel(command('snapshot').id); await cancelled;
    const next = bridge.execute({ ...command('open'), id: 'new-open', path: 'D:/project/new.glb' }); await flush();
    bind(bridge); expect(await next).toMatchObject({ status: 'ready', path: 'D:/project/new.glb' });
    bridge.dispose();
  });

  it('a stale unmount cannot detach a replacement model controller', async () => {
    const bridge = new AgentModelPreviewBridge();
    const first = bridge.execute(command('open')); await flush(); bind(bridge); await first;
    const old = bridge.sessions()[0]!;
    const second = bridge.execute({ ...command('open'), path: 'D:/project/other.glb' }); await flush();
    bind(bridge); bridge.bind('a', old.key, null); await second;
    expect(await bridge.execute(command('snapshot'))).toMatchObject({ path: 'D:/project/other.glb' });
    bridge.dispose();
  });

  it('host replacement cancels old observations without discarding the scene', async () => {
    const bridge = new AgentModelPreviewBridge();
    const opened = bridge.execute(command('open')); await flush(); const controller = bind(bridge); await opened;
    controller.capture = () => new Promise(() => {});
    const old = bridge.execute(command('snapshot')); const rejected = expect(old).rejects.toThrow('取消'); await flush();
    bridge.cancelAll(); await rejected;
    expect(bridge.sessions()).toHaveLength(1);
    expect(await bridge.execute({ ...command('view'), id: 'new-host-view' })).toMatchObject({ status: 'ready' });
    bridge.dispose();
  });
});
