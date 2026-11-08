// pptxviewjs 1.1.9 replaces the browser's FileReader with a utility class.
// Its Logger/renderer globals are required by its own processor, so retain
// those existing vendor globals and restore only the native browser API.
type PptxRuntime = typeof import('pptxviewjs');
let runtime: Promise<PptxRuntime> | undefined;

export function loadPptxRuntime(): Promise<PptxRuntime> {
  if (!runtime) {
    runtime = (async () => {
      const nativeReader = window.FileReader;
      try { return await import('pptxviewjs'); }
      finally {
        window.FileReader = nativeReader;
      }
    })().catch((error: unknown) => { runtime = undefined; throw error; });
  }
  return runtime;
}
