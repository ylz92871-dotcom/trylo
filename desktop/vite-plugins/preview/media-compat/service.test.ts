// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MediaCompatibility } from './service';
import { probeMedia } from './process';
import { mediaProbeArguments } from '../../../src/preview/providers/media-playlist';
import { verifyMediaEngine } from '../../../scripts/preview/media-engine.mjs';

const fixtures = process.env.TRYLO_MEDIA_TEST_FIXTURES;
const engineRoot = process.env.TRYLO_MEDIA_TEST_ENGINE;
const real = fixtures && engineRoot ? it : it.skip;
real('converts genuine video/audio containers through the production compatibility service', async () => {
  const directory = await mkdtemp(path.join(fixtures!, 'dev-matrix-'));
  const service = new MediaCompatibility(path.join(directory, 'cache'), engineRoot);
  const engine = await verifyMediaEngine(engineRoot);
  const matrix = path.join(fixtures!, 'matrix');
  const names = (await readdir(matrix)).filter((name) => name !== 'source-long.mkv');
  expect(names.length).toBeGreaterThanOrEqual(24);
  try {
    for (const [index, name] of names.entries()) {
      const token = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
      const source = path.join(matrix, name);
      const original = createHash('sha256').update(await readFile(source)).digest('hex');
      const info = await service.open(token, source);
      const encoded = await service.segment(token, 0);
      const output = path.join(directory, `${name}.ts`); await writeFile(output, encoded);
      const data = await probeMedia(engine.probe, mediaProbeArguments(), output, new AbortController().signal) as { streams: { codec_name: string }[] };
      if (info.videoIndex !== undefined) expect(data.streams.some((stream) => stream.codec_name === 'h264'), name).toBe(true);
      if (info.audioIndex !== undefined) expect(data.streams.some((stream) => stream.codec_name === 'aac'), name).toBe(true);
      await service.close(token);
      expect(createHash('sha256').update(await readFile(source)).digest('hex'), name).toBe(original);
    }
  } finally { await service.shutdown(); }
}, 120_000);
real('restarts for a distant seek and backward seek without leaving an owned encoder running', async () => {
  const directory = await mkdtemp(path.join(fixtures!, 'dev-seek-'));
  const service = new MediaCompatibility(path.join(directory, 'cache'), engineRoot);
  const token = '00000000-0000-4000-8000-000000000099';
  try {
    const info = await service.open(token, path.join(fixtures!, 'matrix/source-long.mkv')); expect(info.duration).toBeCloseTo(70, 1);
    for (const index of [0, 9, 0]) expect((await service.segment(token, index)).length).toBeGreaterThan(188);
    await service.close(token);
    expect(await readdir(path.join(directory, 'cache'))).toEqual([]);
  } finally { await service.shutdown(); }
}, 60_000);
real('serves actual forward/seek pieces, preserves the source, and reaps a closed producer', async () => {
  const directory = await mkdtemp(path.join(fixtures!, 'dev-acceptance-'));
  const cache = path.join(directory, 'cache'); const source = path.join(fixtures!, 'source.mkv');
  const original = createHash('sha256').update(await readFile(source)).digest('hex');
  const service = new MediaCompatibility(cache, engineRoot);
  const token = '00000000-0000-4000-8000-000000000001';
  const engine = await verifyMediaEngine(engineRoot);
  try {
    const info = await service.open(token, source); expect(info.duration).toBeCloseTo(14, 1);
    for (const index of [0, 2, 1]) {
      const bytes = await service.segment(token, index); expect(bytes.length).toBeGreaterThan(188);
      const file = path.join(directory, `piece-${index}.ts`); await writeFile(file, bytes);
      const data = await probeMedia(engine.probe, mediaProbeArguments(), file, new AbortController().signal) as { streams: { codec_name: string }[] };
      expect(data.streams.some((stream) => stream.codec_name === 'h264')).toBe(true);
    }
    await service.close(token);
    await expect(service.segment(token, 0)).rejects.toThrow('关闭');
    expect(await readdir(cache)).toEqual([]);
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(original);
    const openToken = '00000000-0000-4000-8000-000000000002';
    const opening = service.open(openToken, source);
    await service.close(openToken);
    await expect(opening).rejects.toThrow();
  } finally {
    await service.shutdown();
    // Preserve generated output/evidence; only the service's empty cache is removed.
    if (await stat(cache).catch(() => false)) await rmdir(cache);
  }
}, 60_000);
it('rejects invalid IDs before starting any media job', async () => {
  const service = new MediaCompatibility('unused-cache', 'unused-engine');
  await expect(service.open('../bad', 'unused-source')).rejects.toThrow('标识');
  await expect(service.segment('missing', 0)).rejects.toThrow('关闭');
});
