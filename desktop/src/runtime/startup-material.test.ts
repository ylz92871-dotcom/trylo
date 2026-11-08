// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(resolve('public/startup/material.js'), 'utf8');

it('reuses an unchanged material frame while retaining redraws after a resize', () => {
  const gl = new Proxy({} as Record<string, any>, { get(target, key: string) {
    return target[key] ??= /^[A-Z_0-9]+$/.test(key) ? key : vi.fn(() => true);
  } });
  const scope: Record<string, any> = {};
  runInNewContext(source, scope);
  const canvas = { width: 400, height: 400, getContext: () => gl };
  const material = scope.TryloStartupMaterial(canvas, {}, {});
  expect(material.draw(1.55, 0)).toBe(true);
  for (let frame = 0; frame < 150; frame++) expect(material.draw(1.55, 0)).toBe(false);
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
  canvas.width = canvas.height = 800;
  expect(material.draw(1.55, 0)).toBe(true);
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  material.dispose();
});

function documentMaterial() {
  const workers: any[] = [];
  class Worker {
    onmessage?: (event: any) => void;
    onerror?: (event: any) => void;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { workers.push(this); }
  }
  const window: Record<string, any> = {};
  const bitmaps = [{ close: vi.fn() }, { close: vi.fn() }];
  let index = 0;
  runInNewContext(source, { window, Worker, createImageBitmap: async () => bitmaps[index++] });
  const canvas = { width: 400, height: 400, getContext: vi.fn(), transferControlToOffscreen: vi.fn(() => ({})) };
  const ready = vi.fn(), failed = vi.fn();
  const material = window.TryloStartupMaterial(canvas, {}, {}, ready, failed);
  return { canvas, material, worker: workers[0], ready, failed, bitmaps };
}

it('initializes graphics off the document thread and submits only changing frames', async () => {
  const { canvas, material, worker, ready } = documentMaterial();
  material.draw(.2, 1);
  await new Promise(resolve => setImmediate(resolve));
  expect(canvas.getContext).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledTimes(1); // transferred initialization
  worker.onmessage({ data: { type: 'ready' } });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(material.draw(.2, 1)).toBe(false);
  material.resize(800, 800);
  expect(material.draw(.2, 1)).toBe(true);
  material.dispose();
  worker.onmessage({ data: { type: 'ready' } });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('releases pending image copies after cancellation instead of starting a late renderer', async () => {
  const { material, worker, bitmaps, ready } = documentMaterial();
  material.dispose();
  await new Promise(resolve => setImmediate(resolve));
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
  expect(ready).not.toHaveBeenCalled();
});
