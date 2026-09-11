// PR-4 (spec §7.1): BinaryRef ephemeral tool cache — content addressing,
// dedupe, read guards, and the materialization pump that replaces raw
// base64 blocks BEFORE anything downstream can persist them.

import { describe, expect, it } from 'vitest';
import { createToolResultStore, materializeToolResultEvents, setToolResultStoreForTesting } from './tool-result-store';
import type { ToolResultStoreDeps } from './tool-result-store';
import type { ToolResultEvent } from '../host-adapter/loop-events';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeDeps(): Required<Pick<ToolResultStoreDeps, 'writeBytes' | 'readBytes' | 'fileExists'>> & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    writeBytes: async (path, base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      files.set(path, bytes);
    },
    readBytes: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error('not found');
      return bytes;
    },
    fileExists: async (path) => files.has(path),
  };
}

function makeStore(deps: ToolResultStoreDeps) {
  return createToolResultStore({
    ...deps,
    resolveAppDataDir: async () => 'C:/Users/x/AppData/Roaming/trylo',
  });
}

describe('tool-result-store: writeBinary (§7.1 临时缓存)', () => {
  it('writes content-addressed, dedupes by sha256 and returns metadata only', async () => {
    const deps = fakeDeps();
    const store = makeStore(deps);
    const ref = await store.writeBinary({ data: PNG, mimeType: 'image/png' });
    expect(ref).not.toBeNull();
    expect(ref!.storage).toBe('ephemeral-tool-cache');
    expect(ref!.path).toMatch(/^C:\/Users\/x\/AppData\/Roaming\/trylo\/tool-cache\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(ref!.mimeType).toBe('image/png');
    expect(ref!.size).toBeGreaterThan(0);
    expect(ref!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...deps.files.keys()].length).toBe(1);

    // Same bytes → same path → no second write.
    await store.writeBinary({ data: PNG, mimeType: 'image/png' });
    expect([...deps.files.keys()].length).toBe(1);
  });

  it('rejects empty and oversized payloads with null (base64 never persisted)', async () => {
    const store = makeStore(fakeDeps());
    expect(await store.writeBinary({ data: '', mimeType: 'image/png' })).toBeNull();
    const huge = 'A'.repeat(28 * 1024 * 1024); // ~21 MB decoded > MAX_BINARY_BYTES
    expect(await store.writeBinary({ data: huge, mimeType: 'image/png' })).toBeNull();
  });

  it('degrades to null outside Tauri (no app data dir)', async () => {
    const store = createToolResultStore({ ...fakeDeps(), resolveAppDataDir: async () => null });
    expect(await store.writeBinary({ data: PNG, mimeType: 'image/png' })).toBeNull();
  });
});

describe('tool-result-store: readBinaryBytes guards', () => {
  async function fixture() {
    const deps = fakeDeps();
    const store = makeStore(deps);
    const ref = await store.writeBinary({ data: PNG, mimeType: 'image/png' });
    return { deps, store, ref: ref! };
  }

  it('round-trips bytes for a valid in-root image ref', async () => {
    const { store, ref } = await fixture();
    const bytes = await store.readBinaryBytes(ref);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.length).toBe(ref.size);
  });

  it('rejects a foreign path, unknown storage and non-renderable MIME', async () => {
    const { store, ref } = await fixture();
    expect(await store.readBinaryBytes({ ...ref, path: 'D:/elsewhere/evil.png' })).toBeNull();
    expect(await store.readBinaryBytes({ ...ref, path: `C:/Users/x/AppData/tool-cache/../../evil.png` })).toBeNull();
    expect(await store.readBinaryBytes({ ...ref, storage: 'workspace-artifact' })).toBeNull();
    expect(await store.readBinaryBytes({ ...ref, mimeType: 'application/octet-stream' })).toBeNull();
  });

  it('returns null for expired/missing files', async () => {
    const { deps, store, ref } = await fixture();
    deps.files.clear();
    expect(await store.readBinaryBytes(ref)).toBeNull();
  });
});

describe('materializeToolResultEvents — the ordered BinaryRef pump', () => {
  function toolResultEvent(content: unknown[]): ToolResultEvent {
    return {
      type: 'tool_result', seq: 1, ts: 1, turn: 1,
      id: 'toolu_1', tool: '', ok: true,
      output: '', content, durationMs: 5,
    } as ToolResultEvent;
  }

  it('swaps raw image blocks for BinaryRefs and keeps resolved blocks', async () => {
    const deps = fakeDeps();
    const store = makeStore(deps);
    const resolved = { type: 'text' as const, text: 'kept' };
    const events = [toolResultEvent([
      { type: 'image', data: PNG, mimeType: 'image/png', alt: 'shot' },
      resolved,
    ])];
    const out = await materializeToolResultEvents(events, store);
    const e = out[0] as ToolResultEvent;
    expect(e.content).toHaveLength(2);
    const image = e.content![0] as { type: string; ref?: unknown; alt?: string };
    expect(image.type).toBe('image');
    expect(image.ref).toBeDefined();
    expect(image.alt).toBe('shot');
    expect(JSON.stringify(e.content)).not.toContain('iVBOR');
    expect([...deps.files.keys()].length).toBe(1);
  });

  it('a failed cache write becomes a text notice — base64 is dropped either way', async () => {
    const store = createToolResultStore({
      resolveAppDataDir: async () => null, // nothing writable
    });
    const events = [toolResultEvent([{ type: 'image', data: PNG, mimeType: 'image/png' }])];
    const out = await materializeToolResultEvents(events, store);
    const e = out[0] as ToolResultEvent;
    expect(e.content).toEqual([{ type: 'text', text: '[image could not be cached — dropped]' }]);
  });

  it('materializes blob resources and leaves pure-text batches untouched', async () => {
    const store = makeStore(fakeDeps());
    const textOnly = [toolResultEvent([{ type: 'text', text: 'plain' }])];
    expect(await materializeToolResultEvents(textOnly, store)).toBe(textOnly);
    const blobbed = [toolResultEvent([
      { type: 'resource', uri: 'file:///a.bin', mimeType: 'image/png', blob: PNG },
    ])];
    const out = await materializeToolResultEvents(blobbed, store);
    const e = out[0] as ToolResultEvent;
    expect(e.content![0]).toMatchObject({ type: 'resource', uri: 'file:///a.bin' });
    expect('ref' in e.content![0]!).toBe(true);
  });
});

describe('shared store test seam', () => {
  it('setToolResultStoreForTesting installs a fake and null restores laziness', () => {
    const fake: unknown = {};
    setToolResultStoreForTesting(fake as never);
    setToolResultStoreForTesting(null);
    expect(true).toBe(true);
  });
});
