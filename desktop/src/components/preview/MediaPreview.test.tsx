import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn(), compatible: vi.fn(), attach: vi.fn() }));
vi.mock('../../host-adapter/preview/media', () => ({ openPreviewMedia: mock.open, openCompatibleMedia: mock.compatible }));
vi.mock('./media-playback', () => ({ attachMediaPlayback: mock.attach }));
import { MediaPreview } from './MediaPreview';
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  mock.attach.mockImplementation(async (element: HTMLMediaElement, source: { url: string }) => { element.src = source.url; return () => { element.removeAttribute('src'); }; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); mock.open.mockReset(); mock.compatible.mockReset(); mock.attach.mockReset(); });

it('revokes the old source when the same relative file switches projects and releases late grants', async () => {
  let finishOld!: (source: { url: string; release: () => void }) => void;
  const oldRelease = vi.fn(); const newRelease = vi.fn();
  mock.open.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ url: 'https://media.invalid/new', release: newRelease });
  const view = render(<MediaPreview path="clip.mp4" allowedRoot="D:/one" kind="video" />);
  view.rerender(<MediaPreview path="clip.mp4" allowedRoot="D:/two" kind="video" />);
  await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('https://media.invalid/new'));
  finishOld({ url: 'https://media.invalid/old', release: oldRelease });
  await waitFor(() => expect(oldRelease).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector('video')?.getAttribute('src')).toBe('https://media.invalid/new');
  view.unmount(); expect(newRelease).toHaveBeenCalledTimes(1);
});
it('automatically falls back once and releases both sessions on fatal playback failure', async () => {
  const directRelease = vi.fn(); const compatibilityRelease = vi.fn();
  mock.open.mockResolvedValue({ url: 'https://media.invalid/original', release: directRelease });
  mock.compatible.mockResolvedValue({ url: 'https://media.invalid/index.m3u8', mode: 'hls', release: compatibilityRelease });
  const view = render(<MediaPreview path="clip.mkv" allowedRoot="D:/one" kind="video" />);
  const video = view.container.querySelector('video')!;
  await waitFor(() => expect(video.src).toContain('original'));
  fireEvent.error(video);
  await waitFor(() => expect(mock.compatible).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(video.src).toContain('index.m3u8'));
  expect(directRelease).toHaveBeenCalledTimes(1);
  fireEvent.error(video);
  expect(await screen.findByText(/兼容播放失败/)).toBeTruthy();
  expect(compatibilityRelease).toHaveBeenCalledTimes(1);
  view.unmount(); expect(compatibilityRelease).toHaveBeenCalledTimes(1);
});
it('keeps playback rate consistent after metadata and clamps jumps to the actual duration', async () => {
  mock.open.mockResolvedValue({ url: 'https://media.invalid/video', release: vi.fn() });
  const view = render(<MediaPreview path="clip.mp4" allowedRoot="D:/one" kind="video" />);
  const video = view.container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('https://media.invalid/video'));
  fireEvent.change(screen.getByRole('combobox', { name: '播放速度' }), { target: { value: '1.5' } });
  Object.defineProperty(video, 'duration', { value: 12, configurable: true });
  video.currentTime = 9; fireEvent.loadedMetadata(video); expect(video.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole('button', { name: '播放选项' }));
  fireEvent.click(screen.getByRole('button', { name: '前进 10 秒' })); expect(video.currentTime).toBe(12);
  fireEvent.click(screen.getByRole('button', { name: '后退 10 秒' })); expect(video.currentTime).toBe(2);
});

it('retries a failed open using the same mounted native media element', async () => {
  const release = vi.fn();
  mock.open.mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValueOnce({ url: 'https://media.invalid/recovered', release });
  const view = render(<MediaPreview path="clip.mp4" allowedRoot="D:/one" kind="video" />);
  const element = view.container.querySelector('video');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重试播放' }));
  await waitFor(() => expect(element?.getAttribute('src')).toBe('https://media.invalid/recovered'));
  expect(view.container.querySelector('video')).toBe(element);
  expect(mock.open).toHaveBeenCalledTimes(2);
  view.unmount(); expect(release).toHaveBeenCalledTimes(1);
});
