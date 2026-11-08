// @vitest-environment node
import { mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const delay = vi.hoisted(() => ({ target: '', holdNext: false, blocked: undefined as (() => void) | undefined, resume: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (target: Parameters<typeof actual.stat>[0]) => {
    const result = await actual.stat(target);
    if (delay.holdNext && String(target) === delay.target) {
      delay.holdNext = false; delay.blocked?.();
      await new Promise<void>((resolve) => { delay.resume = resolve; });
    }
    return result;
  } };
});
import { MediaCompatibility } from './service';
const fixtures = process.env.TRYLO_MEDIA_TEST_FIXTURES; const engine = process.env.TRYLO_MEDIA_TEST_ENGINE;
(fixtures && engine ? it : it.skip)('does not let an older distant seek with delayed file metadata cancel the newer position', async () => {
  const directory = await mkdtemp(path.join(fixtures!, 'seek-race-'));
  const service = new MediaCompatibility(path.join(directory, 'cache'), engine);
  const token = '00000000-0000-4000-8000-000000000098';
  try {
    delay.target = path.join(fixtures!, 'matrix/source-long.mkv');
    await service.open(token, delay.target); await service.segment(token, 0);
    const blocked = new Promise<void>((resolve) => { delay.blocked = resolve; });
    delay.holdNext = true;
    const older = service.segment(token, 9).then(() => 'resolved', (error: unknown) => String(error));
    await blocked;
    const current = await service.segment(token, 6); expect(current.length).toBeGreaterThan(188);
    delay.resume?.();
    expect(await older).toContain('位置已改变');
    expect((await service.segment(token, 7)).length).toBeGreaterThan(188);
    await service.close(token); expect(await readdir(path.join(directory, 'cache'))).toEqual([]);
  } finally { delay.holdNext = false; delay.resume?.(); await service.shutdown(); }
}, 60_000);
