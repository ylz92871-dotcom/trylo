// Trylo Desktop — S-1 security regressions for the Excel preview parser.
//
// GHSA-4r6h-8v6p-xvw6 (Prototype Pollution, CVE-2023-30533): fixed in 0.19.3.
// GHSA-5pgg-2g8v-p4x9 (ReDoS, CVE-2024-22363): fixed in 0.20.2.
// npm never ships the fixed versions (SheetJS distributes 0.19+ only via
// cdn.sheetjs.com), so the dependency is a pinned CDN tarball and these
// tests are the standing guard that the parser stays safe.

import { describe, expect, it } from 'vitest'
import { workbookToTables } from './excelTable'

// Crafted OOXML workbook whose comments part carries <comment ref="__proto__">.
// Differential evidence (2026-09-11, node 24): xlsx@0.18.5 injects the key "c"
// onto Object.prototype while parsing this buffer; xlsx@0.20.3 leaves it clean.
const PROTOTYPE_POLLUTION_XLSX_B64 =
  'UEsDBBQAAAAAAAAAIQBI/nyerQIAAK0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlRG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC9jb21tZW50czEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwuY29tbWVudHMreG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAAAAhAAZZx4IoAQAAKAEAAAsAAABfcmVscy8ucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAIQARKtxjGAEAABgBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8d29ya2Jvb2sgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PHNoZWV0cz48c2hlZXQgbmFtZT0iUzEiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAACEAmm88fCkBAAApAQAAGgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAIQBCc/WGIgEAACIBAAAjAAAAeGwvd29ya3NoZWV0cy9fcmVscy9zaGVldDEueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkOSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9jb21tZW50cyIgVGFyZ2V0PSIuLi9jb21tZW50czEueG1sIi8+PC9SZWxhdGlvbnNoaXBzPlBLAwQUAAAAAAAAACEA1Fxu7tkAAADZAAAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPHdvcmtzaGVldCB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIj48c2hlZXREYXRhPjxjIHI9IkExIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5oZWxsbzwvdD48L2lzPjwvYz48L3NoZWV0RGF0YT48L3dvcmtzaGVldD5QSwMEFAAAAAAAAAAhAO2pLrcaAQAAGgEAABAAAAB4bC9jb21tZW50czEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pjxjb21tZW50cyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIj48YXV0aG9ycz48YXV0aG9yPmE8L2F1dGhvcj48L2F1dGhvcnM+PGNvbW1lbnRMaXN0Pjxjb21tZW50IHJlZj0iX19wcm90b19fIiBhdXRob3JJZD0iMCI+PHRleHQ+PHI+PHQ+eDwvdD48L3I+PC90ZXh0PjwvY29tbWVudD48L2NvbW1lbnRMaXN0PjwvY29tbWVudHM+UEsBAhQAFAAAAAAAAAAhAEj+fJ6tAgAArQIAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAAAAAAACEABlnHgigBAAAoAQAACwAAAAAAAAAAAAAAAADeAgAAX3JlbHMvLnJlbHNQSwECFAAUAAAAAAAAACEAESrcYxgBAAAYAQAADwAAAAAAAAAAAAAAAAAvBAAAeGwvd29ya2Jvb2sueG1sUEsBAhQAFAAAAAAAAAAhAJpvPHwpAQAAKQEAABoAAAAAAAAAAAAAAAAAdAUAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzUEsBAhQAFAAAAAAAAAAhAEJz9YYiAQAAIgEAACMAAAAAAAAAAAAAAAAA1QYAAHhsL3dvcmtzaGVldHMvX3JlbHMvc2hlZXQxLnhtbC5yZWxzUEsBAhQAFAAAAAAAAAAhANRcbu7ZAAAA2QAAABgAAAAAAAAAAAAAAAAAOAgAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLAQIUABQAAAAAAAAAIQDtqS63GgEAABoBAAAQAAAAAAAAAAAAAAAAAEcJAAB4bC9jb21tZW50czEueG1sUEsFBgAAAAAHAAcA1AEAAI8KAAAAAA=='

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function objectPrototypeKeys(): string[] {
  return Object.getOwnPropertyNames(Object.prototype).sort()
}

describe('excelTable security regressions (S-1)', () => {
  it('GHSA-4r6h: crafted comment ref does not pollute Object.prototype', () => {
    const before = objectPrototypeKeys()
    expect(() => workbookToTables(b64ToBytes(PROTOTYPE_POLLUTION_XLSX_B64))).not.toThrow()
    expect(objectPrototypeKeys()).toEqual(before)
    // "c" is the key observed injected under xlsx@0.18.5.
    expect(({} as Record<string, unknown>)['c']).toBeUndefined()
  })

  it('GHSA-5pgg: pathological numeric-looking field does not stall parsing', () => {
    // A long run of "(" before a digit sends vulnerable parsing into
    // quadratic backtracking (0.18.5 measured: 40k chars -> 513ms, O(N^2));
    // 0.20.2 reworked the parse to linear (measured: 1M chars -> 14ms).
    const bytes = new TextEncoder().encode('(' + '('.repeat(1_000_000) + '1\n')
    const started = performance.now()
    const tables = workbookToTables(bytes)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(3000)
    expect(tables.sheets.length).toBeGreaterThan(0)
  })
})
