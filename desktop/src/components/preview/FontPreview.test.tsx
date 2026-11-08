import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ bytes: { status: 'ready' as const, bytes: new Uint8Array([1, 2]) }, load: vi.fn() }));
vi.mock('./usePreviewBytes', () => ({ usePreviewBytes: () => mock.bytes }));
import { FontPreview } from './FontPreview';
const original = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); if (original) Object.defineProperty(document, 'fonts', original); else Reflect.deleteProperty(document, 'fonts'); mock.load.mockReset(); });
function setup() {
  const fonts = { add: vi.fn(), delete: vi.fn() };
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  vi.stubGlobal('FontFace', class { load = mock.load; }); return fonts;
}
it('loads a private font for editable samples and removes it on close', async () => {
  const fonts = setup(); mock.load.mockResolvedValue(undefined);
  const view = render(<FontPreview path="brand.woff2" allowedRoot="D:/project" />);
  await screen.findByRole('textbox', { name: '字体预览文本' }); expect(fonts.add).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('slider', { name: '预览字号' }), { target: { value: '72' } });
  expect(screen.getByText('72 px')).toBeTruthy();
  view.unmount(); expect(fonts.delete).toHaveBeenCalledTimes(1);
});
it('does not register a font that finishes after its preview closes', async () => {
  const fonts = setup(); let finish!: () => void;
  mock.load.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<FontPreview path="late.ttf" allowedRoot="D:/project" />); view.unmount(); finish();
  await waitFor(() => expect(fonts.delete).toHaveBeenCalledTimes(1)); expect(fonts.add).not.toHaveBeenCalled();
});
