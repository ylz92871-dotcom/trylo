import { expect, it, vi } from 'vitest';
vi.mock('pptxviewjs', () => {
  Reflect.set(window, 'FileReader', class IncompatibleReader {});
  Reflect.set(window, 'Logger', class VendorLogger {});
  return { PPTXViewer: class {
    constructor() { if (!Reflect.get(window, 'Logger')) throw Error('Missing required dependencies: Logger'); }
  } };
});
it('preserves native browser readers during concurrent PPTX loads without removing required vendor dependencies', async () => {
  const nativeReader = window.FileReader;
  const originalLogger = Object.getOwnPropertyDescriptor(window, 'Logger');
  try {
    const { loadPptxRuntime } = await import('./pptxRuntime');
    const [first, second] = await Promise.all([loadPptxRuntime(), loadPptxRuntime()]);
    expect(first).toBe(second);
    expect(window.FileReader).toBe(nativeReader);
    expect(typeof new window.FileReader().readAsArrayBuffer).toBe('function');
    expect(new first.PPTXViewer()).toBeTruthy();
  } finally {
    if (originalLogger) Object.defineProperty(window, 'Logger', originalLogger);
    else Reflect.deleteProperty(window, 'Logger');
    window.FileReader = nativeReader;
  }
});
