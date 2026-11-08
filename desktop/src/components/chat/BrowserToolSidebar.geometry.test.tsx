import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserToolSidebar } from './BrowserToolSidebar';
import type { BrowserPreviewController } from '../../tooling/use-browser-preview';

const observers: ResizeObserverCallback[] = [];
class ResizeFixture {
  constructor(callback: ResizeObserverCallback) {
    observers.push(callback);
  }
  observe(): void {}
  disconnect(): void {}
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.length = 0;
});

it('reports committed panel bounds before paint and does not postpone a pending resize on every observer notification', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0,
    width = 480;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal('ResizeObserver', ResizeFixture);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 1000 - width,
    left: 1000 - width,
    y: 200,
    top: 200,
    width,
    height: 600,
    right: 1000,
    bottom: 800,
    toJSON() {},
  }));
  const nothing = async (): Promise<void> => {};
  const preview: BrowserPreviewController = {
    scope: 'resize-fixture',
    status: 'running',
    detail: '',
    url: 'https://page.test',
    zoom: 1,
    frameSeq: 0,
    latestFrame: null,
    nativeState: {
      ok: true,
      scope: 'resize-fixture',
      state: 'running',
      detail: '',
      control: 'agent',
      inFlight: 0,
      activeLabel: 'one',
      tabs: [{ id: 'one', label: 'one', title: 'Page', url: 'https://page.test' }],
    },
    start: nothing,
    stop: nothing,
    navigate: nothing,
    input: nothing,
    setVisible: () => {},
    setViewportSize: () => {},
    setBounds: vi.fn(nothing),
    setZoom: nothing,
    takeControl: nothing,
    releaseControl: nothing,
    selectTab: nothing,
    createTab: nothing,
  };
  const state = { title: '浏览器', status: '', detail: '' };
  const view = render(
    <BrowserToolSidebar state={state} preview={preview} width={width} onClose={() => {}} />,
  );
  expect(preview.setBounds).toHaveBeenLastCalledWith(
    { x: 520, y: 200, width: 480, height: 600 },
    true,
  );
  width = 720;
  view.rerender(
    <BrowserToolSidebar state={state} preview={preview} width={width} onClose={() => {}} />,
  );
  expect(preview.setBounds).toHaveBeenLastCalledWith(
    { x: 280, y: 200, width: 720, height: 600 },
    true,
  );
  width = 750;
  const resize = observers.at(-1)!;
  resize([], {} as ResizeObserver);
  resize([], {} as ResizeObserver);
  resize([], {} as ResizeObserver);
  expect(frames.size).toBe(1);
  const [id, callback] = [...frames][0]!;
  frames.delete(id);
  callback(16);
  expect(preview.setBounds).toHaveBeenLastCalledWith(
    { x: 250, y: 200, width: 750, height: 600 },
    true,
  );
  view.unmount();
  expect(preview.setBounds).toHaveBeenLastCalledWith(expect.any(Object), false);
  expect(frames.size).toBe(0);
});
