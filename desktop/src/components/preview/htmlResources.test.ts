import { describe, it, expect, vi } from 'vitest';
import { localResourcePath, prepareHtml } from './htmlResources';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewResource: read }));
describe('local HTML resources', () => {
  it('resolves relative assets but rejects absolute and escaped paths', () => {
    expect(localResourcePath('D:/repo/out/page.html', 'D:/repo', '../assets/a.png')).toBe('D:/repo/assets/a.png');
    for (const reference of ['../../secret.png', '%2e%2e/%2e%2e/secret.png', 'file:///C:/secret', 'C:/secret', '//host/file', '/secret']) expect(localResourcePath('D:/repo/out/page.html', 'D:/repo', reference)).toBeUndefined();
  });
  it('embeds styles/images and reports missing assets while keeping content', async () => {
    read.mockImplementation(async (path: string) => {
      if (path.endsWith('.css')) return new TextEncoder().encode('body{background-image:url("chart.png")}');
      if (path.endsWith('chart.png')) return new Uint8Array([1, 2, 3]);
      throw new Error('missing');
    });
    const result = await prepareHtml('<base href="file:///C:/"><link rel="stylesheet" href="style.css"><h1>Keep this</h1><img src="chart.png"><img src="missing.png">', 'D:/repo/out/page.html', 'D:/repo', new AbortController().signal);
    expect(result.html).toContain('Keep this');
    expect(result.html).toContain('data:image/png;base64,AQID');
    expect(result.html).not.toContain('<base');
    expect(result.warnings).toEqual(['missing.png']);
  });
});
