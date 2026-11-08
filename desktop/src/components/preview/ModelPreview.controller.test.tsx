import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import type { Mock, MockInstance } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { PerspectiveCamera, Scene } from 'three';

const fixture = await vi.hoisted(async () => {
  const { vi } = await import('vitest');
  return {
  read: vi.fn(),
  events: [] as string[],
  renderers: [] as { dispose: Mock; render: Mock }[],
  controls: [] as { dispose: Mock }[],
  geometries: [] as { dispose: MockInstance<[], void> }[],
  };
});

vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewBinary: fixture.read }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    dispose = vi.fn();
    render = vi.fn((_scene: Scene, _camera: PerspectiveCamera) => { fixture.events.push('render'); });
    constructor() {
      fixture.renderers.push(this);
    }
    setPixelRatio(): void {}
    setSize(width: number, height: number): void { this.domElement.width = width; this.domElement.height = height; }
  } };
});
vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return { OrbitControls: class {
    target = new Vector3();
    enableDamping = false;
    dispose = vi.fn();
    update(): void {}
    constructor() { fixture.controls.push(this); }
  } };
});
vi.mock('three/addons/loaders/STLLoader.js', async () => {
  const { BoxGeometry } = await import('three');
  return { STLLoader: class { parse(): InstanceType<typeof BoxGeometry> {
    const geometry = new BoxGeometry(2, 3, 4);
    const dispose = vi.spyOn(geometry, 'dispose');
    fixture.geometries.push({ dispose });
    return geometry;
  } } };
});

import { ModelPreview } from './ModelPreview';
import type { ModelCameraPose as Pose, ModelPreviewState as State, ModelPreviewController as Controller } from './modelPreviewController';

beforeEach(() => {
  fixture.read.mockReset().mockResolvedValue(new Uint8Array([1]));
  fixture.events.length = 0;
  fixture.renderers.length = 0;
  fixture.controls.length = 0;
  fixture.geometries.length = 0;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const context: Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect' | 'createRadialGradient' | 'fillStyle'> = {
    drawImage: () => { fixture.events.push('copy'); },
    fillRect: () => { fixture.events.push('background'); },
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fillStyle: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    backgroundImage: 'radial-gradient(circle at 50% 40%, #1c2530 0%, #101418 70%)', backgroundColor: 'rgba(0, 0, 0, 0)',
  } as CSSStyleDeclaration);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
    fixture.events.push('capture');
    return 'data:image/jpeg;base64,fixture';
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function open(revision = 'v1', root = 'D:/project') {
  let controller: Controller | null = null;
  const bind = (value: Controller | null): void => { controller = value; };
  const props = { path: 'model.stl', allowedRoot: root, revision, onController: bind };
  const view = render(<ModelPreview {...props} />);
  return { ...view, props, controller: (): Controller => {
    expect(controller).not.toBeNull();
    return controller!;
  }, bound: (): Controller | null => controller };
}

it('captures a rendered ready revision and releases the renderer/controller on unmount', async () => {
  const view = open();
  await waitFor(() => expect(view.controller().getState().status).toBe('ready'));
  expect(fixture.read).toHaveBeenCalledWith('model.stl', 'D:/project');
  const state = view.controller().getState();
  expect(state).toMatchObject({ path: 'model.stl', revision: 'v1', readyVersion: state.version, scene: {
    meshes: 1, vertices: 24, triangles: 12, bounds: { min: [-1, -1.5, -2], max: [1, 1.5, 2] },
  } });
  fixture.events.length = 0;
  const capture = await view.controller().capture();
  expect(capture).toMatchObject({ path: 'model.stl', revision: 'v1', version: state.version, dataUrl: 'data:image/jpeg;base64,fixture', mimeType: 'image/jpeg' });
  expect(capture.width).toBeGreaterThan(0);
  expect(capture.height).toBeGreaterThan(0);
  expect(fixture.events.slice(-4)).toEqual(['render', 'background', 'copy', 'capture']);
  view.unmount();
  expect(view.bound()).toBeNull();
  expect(fixture.renderers[0]?.dispose).toHaveBeenCalledOnce();
  expect(fixture.controls[0]?.dispose).toHaveBeenCalledOnce();
  expect(fixture.geometries[0]?.dispose).toHaveBeenCalledOnce();
});

it('reloads same-path revisions and manual reload while retaining camera, target and wireframe', async () => {
  const view = open();
  await waitFor(() => expect(view.controller().getState().status).toBe('ready'));
  const controller = view.controller();
  const pose: Pose = { position: [10, 20, 30], target: [1, 2, 3] };
  act(() => { controller.setCamera(pose); controller.setWireframe(true); });
  const firstVersion = controller.getState().version;
  view.rerender(<ModelPreview {...view.props} revision="companion-v2" />);
  await waitFor(() => expect(controller.getState()).toMatchObject({ status: 'ready', revision: 'companion-v2' }));
  expect(view.controller()).toBe(controller);
  expect(controller.getState().version).toBeGreaterThan(firstVersion);
  expect(await controller.capture()).toMatchObject({ camera: pose, wireframe: true, revision: 'companion-v2' });
  await act(async () => { await controller.reload(); });
  expect(fixture.read).toHaveBeenCalledTimes(3);
  expect(fixture.renderers).toHaveLength(1);
  expect(await controller.capture()).toMatchObject({ camera: pose, wireframe: true });
  expect(fixture.geometries[0]?.dispose).toHaveBeenCalledOnce();
});

it('rejects capture while loading or failed and ignores superseded reads', async () => {
  let resolveOld!: (bytes: Uint8Array) => void;
  fixture.read.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { resolveOld = resolve; }));
  const view = open('old');
  await waitFor(() => expect(view.controller().getState().status).toBe('loading'));
  await expect(view.controller().capture()).rejects.toThrow();
  view.rerender(<ModelPreview {...view.props} revision="new" />);
  await waitFor(() => expect(view.controller().getState()).toMatchObject({ status: 'ready', revision: 'new' }));
  await act(async () => { resolveOld(new Uint8Array([2])); });
  expect(view.controller().getState()).toMatchObject({ status: 'ready', revision: 'new' });
  fixture.read.mockRejectedValueOnce(new Error('permission scope denied'));
  await act(async () => { await expect(view.controller().reload()).rejects.toThrow('permission scope denied'); });
  expect(view.controller().getState()).toMatchObject({ status: 'error', message: 'permission scope denied' });
  await expect(view.controller().capture()).rejects.toThrow();
});

it('clears scope-specific view state on a workspace change and rejects invalid camera values', async () => {
  const view = open();
  await waitFor(() => expect(view.controller().getState().status).toBe('ready'));
  act(() => { view.controller().setCamera({ position: [10, 20, 30], target: [1, 2, 3], up: [0, 0, 1] }); view.controller().setWireframe(true); });
  expect(() => view.controller().setCamera({ position: [NaN, 1, 2], target: [0, 0, 0] })).toThrow();
  view.rerender(<ModelPreview {...view.props} allowedRoot="D:/other" />);
  await waitFor(() => expect(fixture.read).toHaveBeenLastCalledWith('model.stl', 'D:/other'));
  await waitFor(() => expect(view.controller().getState().status).toBe('ready'));
  const capture = await view.controller().capture();
  expect(capture.wireframe).toBe(false);
  expect(capture.camera.position).not.toEqual([10, 20, 30]);
  expect(capture.camera.up).toEqual([0, 1, 0]);
});

it('waits for the ready generation and blocks the prior visible model during a reload', async () => {
  const view = open();
  await view.controller().waitUntilReady();
  let resolve!: (bytes: Uint8Array) => void;
  fixture.read.mockImplementationOnce(() => new Promise<Uint8Array>((finish) => { resolve = finish; }));
  let reloaded!: Promise<State>;
  act(() => { reloaded = view.controller().reload(); });
  const waiting = view.controller().waitUntilReady();
  const loading = view.controller().getState();
  expect(loading.status).toBe('loading');
  expect(loading.readyVersion).toBeNull();
  expect(loading).not.toHaveProperty('scene');
  await expect(view.controller().capture()).rejects.toThrow();
  await act(async () => { resolve(new Uint8Array([2])); await reloaded; });
  expect(await waiting).toMatchObject({ status: 'ready', version: loading.version, readyVersion: loading.version });
  const old = view.controller();
  view.unmount();
  await expect(old.capture()).rejects.toThrow();
  await expect(old.waitUntilReady()).rejects.toThrow();
  await expect(old.reload()).rejects.toThrow();
  expect(fixture.read).toHaveBeenCalledTimes(2);
});

it('captures JPEG within its bounding box without changing the live viewport dimensions', async () => {
  const view = open();
  await view.controller().waitUntilReady();
  const source = view.container.querySelector('canvas')!;
  source.width = 2400;
  source.height = 1200;
  fixture.events.length = 0;
  expect(await view.controller().capture()).toMatchObject({ width: 1024, height: 512, mimeType: 'image/jpeg' });
  expect(fixture.events).toEqual(['render', 'background', 'copy', 'capture']);
  expect(await view.controller().capture({ width: 320, height: 200 })).toMatchObject({ width: 320, height: 160 });
  expect(source.width).toBe(2400);
  expect(source.height).toBe(1200);
  expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenLastCalledWith('image/jpeg', .85);
  await expect(view.controller().capture({ width: -1 })).rejects.toThrow();
});

const signatureOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

it('rejects changed main-file bytes before parsing or capturing a host-pinned revision', async () => {
  const original = new Uint8Array([1]), changed = new Uint8Array([2]);
  fixture.read.mockResolvedValueOnce(changed);
  let controller: Controller | null = null;
  render(<ModelPreview path="model.stl" allowedRoot="D:/project" revision="host-revision"
    expectedFileSignature={signatureOf(original)} onController={value => { controller = value; }} />);
  await waitFor(() => expect(controller?.getState()).toMatchObject({ status: 'error', message: 'model_preview_file_changed_before_render' }));
  expect(fixture.geometries).toHaveLength(0);
  expect(controller!.getState().readyVersion).toBeNull();
  expect(controller!.getState()).not.toHaveProperty('scene');
  await expect(controller!.capture()).rejects.toThrow();
  expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
});

it('reports the exact parsed main-file hash in ready state and frame metadata', async () => {
  const bytes = new Uint8Array([8, 1, 2, 3, 9]).subarray(1, 4);
  const expected = signatureOf(bytes);
  fixture.read.mockResolvedValueOnce(bytes);
  let controller: Controller | null = null;
  render(<ModelPreview path="model.stl" allowedRoot="D:/project" revision="host-revision"
    expectedFileSignature={expected} onController={value => { controller = value; }} />);
  await waitFor(() => expect(controller?.getState()).toMatchObject({ status: 'ready', fileSignature: expected }));
  expect(fixture.geometries).toHaveLength(1);
  expect(await controller!.capture()).toMatchObject({ revision: 'host-revision', fileSignature: expected });
});

it('revalidates a changed expected hash even if the opaque revision is unchanged', async () => {
  const original = new Uint8Array([1]), replacement = new Uint8Array([2]);
  let controller: Controller | null = null;
  const bind = (value: Controller | null): void => { controller = value; };
  const props = { path: 'model.stl', allowedRoot: 'D:/project', revision: 'same-revision', onController: bind };
  const view = render(<ModelPreview {...props} expectedFileSignature={signatureOf(original)} />);
  await waitFor(() => expect(controller?.getState().status).toBe('ready'));
  view.rerender(<ModelPreview {...props} expectedFileSignature={signatureOf(replacement)} />);
  await waitFor(() => expect(controller?.getState()).toMatchObject({ status: 'error', message: 'model_preview_file_changed_before_render' }));
  expect(fixture.geometries).toHaveLength(1);
  await expect(controller!.capture()).rejects.toThrow();
});

it('does not silently skip a required digest when the context has no WebCrypto', async () => {
  vi.stubGlobal('crypto', { subtle: undefined });
  let controller: Controller | null = null;
  render(<ModelPreview path="model.stl" allowedRoot="D:/project" revision="host-revision"
    expectedFileSignature={signatureOf(new Uint8Array([1]))} onController={value => { controller = value; }} />);
  await waitFor(() => expect(controller?.getState()).toMatchObject({ status: 'error', message: 'model_preview_signature_verification_unavailable' }));
  expect(fixture.geometries).toHaveLength(0);
  await expect(controller!.capture()).rejects.toThrow();
});

it('keeps ordinary file preview working without WebCrypto when no host identity is pinned', async () => {
  vi.stubGlobal('crypto', { subtle: undefined });
  const view = open();
  await waitFor(() => expect(view.controller().getState().status).toBe('ready'));
  expect(view.controller().getState()).not.toHaveProperty('fileSignature');
  expect(await view.controller().capture()).toMatchObject({ revision: 'v1', mimeType: 'image/jpeg' });
});
