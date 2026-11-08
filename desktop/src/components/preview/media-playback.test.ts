import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ instances: [] as { destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; attachMedia: ReturnType<typeof vi.fn>; loadSource: ReturnType<typeof vi.fn> }[] }));
vi.mock('hls.js', () => ({ default: class {
  static Events = { ERROR: 'error' }; static isSupported = () => true;
  destroy = vi.fn(); on = vi.fn(); attachMedia = vi.fn(); loadSource = vi.fn();
  constructor() { mock.instances.push(this); }
} }));
import { attachMediaPlayback } from './media-playback';
afterEach(() => { vi.restoreAllMocks(); mock.instances.length = 0; });
it('keeps native controls and destroys the HLS buffer owner on detach', async () => {
  const element = document.createElement('video');
  vi.spyOn(element, 'canPlayType').mockReturnValue(''); vi.spyOn(element, 'pause').mockImplementation(() => {}); vi.spyOn(element, 'load').mockImplementation(() => {});
  const fail = vi.fn(); const abort = new AbortController();
  const close = await attachMediaPlayback(element, { url: 'http://trylo-media.localhost/token/index.m3u8', mode: 'hls', release: vi.fn() }, abort.signal, fail);
  const instance = mock.instances[0]!; expect(instance.attachMedia).toHaveBeenCalledWith(element); expect(instance.loadSource).toHaveBeenCalled();
  const callback = instance.on.mock.calls[0]![1] as (event: string, data: { fatal: boolean }) => void;
  callback('error', { fatal: false }); expect(fail).not.toHaveBeenCalled();
  callback('error', { fatal: true }); expect(fail).toHaveBeenCalledTimes(1);
  abort.abort(); callback('error', { fatal: true }); expect(fail).toHaveBeenCalledTimes(1);
  close(); expect(instance.destroy).toHaveBeenCalledTimes(1); expect(element.hasAttribute('src')).toBe(false);
});
it('does not attach a late stream after its view has closed', async () => {
  const controller = new AbortController(); controller.abort();
  await attachMediaPlayback(document.createElement('video'), { url: 'late', mode: 'hls', release: vi.fn() }, controller.signal, vi.fn());
  expect(mock.instances).toHaveLength(0);
});
