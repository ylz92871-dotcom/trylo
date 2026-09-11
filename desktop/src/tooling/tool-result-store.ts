// Trylo Desktop — BinaryRef ephemeral tool cache (PR-4, spec §7.1).
//
// The stream translator sees MCP image/audio/binary-resource payloads as
// inline base64. That base64 must NEVER reach the session JSON (§15.2
// circuit breaker: 「截图/base64 进入持久会话」). This module is the seam:
//
//   stream-translator (sync, raw blocks in memory)
//     → trylo-runner ordered pump (this module's `materializeToolResultEvents`)
//       → base64 bytes written ONCE to `<appDataDir>/tool-cache/<aa>/<sha256>.<ext>`
//       → event carries a `BinaryRef` (metadata only) from then on
//         (reducer → ToolMessage → conversation history JSON)
//
// The bytes are content-addressed by SHA-256 (repeat screenshots dedupe),
// live OUTSIDE the workspace (never in a repo / git diff), and are
// reclaimed by the Service Host's 24 h TTL sweeper (`tool-result-cache.mjs`
// in desktop-services — the renderer has no delete-capable fs command, so
// FS truth for cleanup lives on the sidecar, same split as the artifact
// promoter). After expiry the metadata survives in the session record and
// the UI renders an "expired" placeholder (§7.1).
//
// Browser dev (no Tauri runtime): every operation degrades to `null` /
// `failed` — a run cannot happen there anyway, so nothing is lost.

import { useEffect, useState } from 'react';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { ToolResultEvent } from '../host-adapter/loop-events';
import {
  MAX_BINARY_BYTES,
  RENDERABLE_AUDIO_MIME,
  RENDERABLE_IMAGE_MIME,
  summarizeToolResultContent,
  type AnyToolResultContent,
  type BinaryRef,
  type ToolResultContent,
} from './tool-result-content';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ToolResultStore {
  /** Write one base64 payload into the cache; returns its BinaryRef, or
   *  `null` when the payload could not be cached (oversized, no Tauri
   *  runtime, IO failure). Callers replace the block with a notice. */
  writeBinary(payload: { readonly data: string; readonly mimeType: string }): Promise<BinaryRef | null>;
  /** Read cached bytes for rendering. Validates the ref against THIS
   *  store's root (a history file can be hand-edited — the persisted path
   *  is never trusted blindly) and the MIME/size guards. `null` when the
   *  bytes are unreadable (expired, missing, foreign path). */
  readBinaryBytes(ref: BinaryRef): Promise<Uint8Array | null>;
  /** Resolved cache root, or `null` outside Tauri / before resolve. */
  cacheRoot(): Promise<string | null>;
}

export interface ToolResultStoreDeps {
  /** Resolves the Tauri app-data dir (default: `servicehost_paths`). */
  readonly resolveAppDataDir?: () => Promise<string | null>;
  /** Write bytes (default: Tauri `write_file_bytes`). */
  readonly writeBytes?: (path: string, base64: string) => Promise<void>;
  /** Read bytes (default: Tauri `read_file_bytes`). */
  readonly readBytes?: (path: string) => Promise<number[] | Uint8Array>;
  /** Existence probe (default: Tauri `stat_file`). */
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly now?: () => number;
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  };
  return map[mimeType.toLowerCase()] ?? 'bin';
}

function isRenderableMime(mimeType: string): boolean {
  const lowered = mimeType.toLowerCase();
  return (RENDERABLE_IMAGE_MIME as readonly string[]).includes(lowered)
    || (RENDERABLE_AUDIO_MIME as readonly string[]).includes(lowered);
}

export function createToolResultStore(deps: ToolResultStoreDeps = {}): ToolResultStore {
  let rootPromise: Promise<string | null> | null = null;

  const resolveAppDataDir = deps.resolveAppDataDir ?? (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const paths = await invoke<{ appDataDir: string }>('servicehost_paths');
      return typeof paths?.appDataDir === 'string' && paths.appDataDir !== '' ? paths.appDataDir : null;
    } catch {
      return null;
    }
  });

  const writeBytes = deps.writeBytes ?? (async (path, base64) => {
    const { tauriFsCommands } = await import('../host-adapter/tauri-fs-commands');
    await tauriFsCommands.writeFileBytes(path, base64);
  });
  const readBytes = deps.readBytes ?? (async (path) => {
    const { tauriFsCommands } = await import('../host-adapter/tauri-fs-commands');
    return tauriFsCommands.readFileBytes(path);
  });
  const fileExists = deps.fileExists ?? (async (path) => {
    try {
      const { tauriFsCommands } = await import('../host-adapter/tauri-fs-commands');
      await tauriFsCommands.statFile(path);
      return true;
    } catch {
      return false;
    }
  });

  function cacheRoot(): Promise<string | null> {
    if (!rootPromise) {
      rootPromise = (async () => {
        const appDataDir = await resolveAppDataDir();
        if (!appDataDir) return null;
        const root = `${appDataDir.replace(/[\\/]+$/, '')}/tool-cache`;
        return root;
      })();
    }
    return rootPromise;
  }

  /** Content-addressed path. The two-level fan-out keeps any single
   *  directory small on NTFS. Same bytes → same path → free dedupe. */
  function cachePathFor(root: string, sha256: string, mimeType: string): string {
    return `${root}/${sha256.slice(0, 2)}/${sha256}.${extensionForMime(mimeType)}`;
  }

  /** The persisted ref path is only usable when it points INTO this
   *  store's root (lexical containment; a tampered history file pointing
   *  at e.g. a document must not render). */
  const isInsideCacheRoot = (root: string, path: string): boolean => isInsideToolCacheRoot(root, path);

  return {
    cacheRoot,

    async writeBinary({ data, mimeType }): Promise<BinaryRef | null> {
      try {
        const root = await cacheRoot();
        if (!root) return null;
        const bytes = base64ToBytes(data);
        if (bytes.length === 0 || bytes.length > MAX_BINARY_BYTES) return null;
        const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
        const sha256 = bytesToHex(digest);
        const path = cachePathFor(root, sha256, mimeType);
        if (!(await fileExists(path))) {
          await writeBytes(path, data);
        }
        return {
          id: `bin-${sha256.slice(0, 16)}`,
          storage: 'ephemeral-tool-cache',
          path,
          mimeType: mimeType || 'application/octet-stream',
          size: bytes.length,
          sha256,
        };
      } catch {
        return null;
      }
    },

    async readBinaryBytes(ref): Promise<Uint8Array | null> {
      try {
        const root = await cacheRoot();
        if (!root) return null;
        if (ref.storage !== 'ephemeral-tool-cache') return null;
        if (!isInsideCacheRoot(root, ref.path)) return null;
        if (!isRenderableMime(ref.mimeType)) return null;
        if (ref.size > MAX_BINARY_BYTES) return null;
        const raw = await readBytes(ref.path);
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        // Expired/missing files that a stale stat may have missed, and
        // truncated files: a partial image must not render as garbage.
        if (bytes.length === 0 || bytes.length > MAX_BINARY_BYTES) return null;
        return bytes;
      } catch {
        return null;
      }
    },
  };
}

// ── shared instance ────────────────────────────────────────────────────

let shared: ToolResultStore | null = null;

/** Production singleton (lazy — created on first use; Tauri-only paths
 *  degrade to null inside the store). */
export function getToolResultStore(): ToolResultStore {
  if (!shared) shared = createToolResultStore();
  return shared;
}

/** Test seam: inject a fake store (or null to restore the lazy default). */
export function setToolResultStoreForTesting(store: ToolResultStore | null): void {
  shared = store;
}

// ── PR-4 偏差②收口: the resource 「打开」 affordance ────────────────────

/** Result of a user-initiated open of one cached binary resource. */
export type OpenToolResourceResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Open ONE cached binary resource with the OS default app — the explicit,
 * user-driven 「打开」 on a tool-card resource block (§7.2). The path is
 * re-validated against THIS cache root before the Tauri command runs, and
 * the Rust `work_host_open_file` gate re-canonicalizes and re-checks
 * containment after symlinks resolve (defense in depth, §7.1: the UI never
 * opens arbitrary URIs — only cache-contained binary refs get the button).
 * Never throws; the caller renders the error inline.
 */
export async function openCachedToolResource(ref: BinaryRef): Promise<OpenToolResourceResult> {
  try {
    const root = await getToolResultStore().cacheRoot();
    if (!root) return { ok: false, error: '桌面环境不可用' };
    if (ref.storage !== 'ephemeral-tool-cache') return { ok: false, error: '仅支持临时资源' };
    if (!isInsideToolCacheRoot(root, ref.path)) return { ok: false, error: '路径不在临时资源区内' };
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('work_host_open_file', { filePath: ref.path, allowedRoot: root });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Lexical containment of a persisted ref path inside the cache root.
 *  Module-level so the open affordance shares the read path's rule. */
function isInsideToolCacheRoot(root: string, path: string): boolean {
  if (path.includes('..')) return false;
  const lower = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const r = lower(root);
  const p = path.toLowerCase();
  return p.startsWith(`${r}/`) || p.startsWith(`${r}\\`);
}

// ── materialization pump ──────────────────────────────────────────────

const UNCACHEABLE_NOTICE: Record<string, string> = {
  image: '[image could not be cached — dropped]',
  audio: '[audio could not be cached — dropped]',
  resource: '[binary resource could not be cached — dropped]',
};

/** Resolve one transient (raw base64) block into the persisted vocabulary.
 *  Resolved blocks pass through untouched. A failed write becomes a text
 *  notice — the base64 is dropped either way. */
async function resolveBlock(
  block: AnyToolResultContent,
  store: ToolResultStore,
): Promise<ToolResultContent> {
  if (block.type === 'image' && !('ref' in block)) {
    const ref = await store.writeBinary({ data: block.data, mimeType: block.mimeType });
    return ref
      ? { type: 'image', ref, ...(block.alt !== undefined ? { alt: block.alt } : {}) }
      : { type: 'text', text: UNCACHEABLE_NOTICE['image']! };
  }
  if (block.type === 'audio' && !('ref' in block)) {
    const ref = await store.writeBinary({ data: block.data, mimeType: block.mimeType });
    return ref
      ? { type: 'audio', ref }
      : { type: 'text', text: UNCACHEABLE_NOTICE['audio']! };
  }
  if (block.type === 'resource' && 'blob' in block) {
    const ref = await store.writeBinary({ data: block.blob, mimeType: block.mimeType ?? 'application/octet-stream' });
    return ref
      ? { type: 'resource', uri: block.uri, ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}), ref }
      : { type: 'resource', uri: block.uri, ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}), text: UNCACHEABLE_NOTICE['resource']! };
  }
  return block;
}

function hasRawBlocks(content: readonly AnyToolResultContent[] | undefined): boolean {
  if (!content) return false;
  return content.some((block) =>
    block.type === 'image' || block.type === 'audio'
      ? !('ref' in block)
      : block.type === 'resource' && 'blob' in block);
}

/** True when the batch contains a tool_result with raw (pre-store) binary
 *  blocks. Used by the runner pump to keep PURE-TEXT batches fully
 *  synchronous — today's streams (and every existing lifecycle test)
 *  must not change timing. */
export function hasRawToolResultEvents(events: readonly LoopEvent[]): boolean {
  return events.some(
    (e) => e.type === 'tool_result' && hasRawBlocks((e as ToolResultEvent).content),
  );
}

/**
 * PR-4 pump: replace every raw base64 block in a batch's tool_result
 * events with BinaryRefs BEFORE the events reach the reducer / UI /
 * history. Fast path: a batch without raw blocks resolves synchronously
 * (no await → zero ordering impact on text/tool streams).
 */
export async function materializeToolResultEvents(
  events: readonly LoopEvent[],
  store: ToolResultStore = getToolResultStore(),
): Promise<readonly LoopEvent[]> {
  const toolResults = events.filter(
    (e): e is ToolResultEvent & { content: readonly AnyToolResultContent[] } =>
      e.type === 'tool_result' && hasRawBlocks((e as ToolResultEvent).content),
  );
  if (toolResults.length === 0) return events;
  const resolved = new Map<LoopEvent, readonly ToolResultContent[]>();
  for (const event of toolResults) {
    const blocks: ToolResultContent[] = [];
    for (const block of event.content) {
      blocks.push(await resolveBlock(block, store));
    }
    resolved.set(event, blocks);
  }
  return events.map((e) => {
    const content = resolved.get(e);
    return content ? ({ ...e, content } as LoopEvent) : e;
  });
}

/** The text summary of a tool_result whose content carries non-text
 *  blocks — used when building the event's `output` field. */
export function textSummaryOfContent(content: readonly AnyToolResultContent[] | undefined): string {
  if (!content || content.length === 0) return '';
  return summarizeToolResultContent(content);
}

// ── React rendering hook ──────────────────────────────────────────────

export interface BinaryRefObjectUrlState {
  /** Object URL for the cached bytes; `null` until ready or on failure. */
  readonly url: string | null;
  /** True when the bytes could not be read (expired / missing / rejected
   *  MIME or path) — the UI renders the "已过期/不可用" placeholder. */
  readonly failed: boolean;
}

/**
 * Resolve a BinaryRef to a renderable object URL (spec §7.1: 缩略图有
 * MIME 白名单、大小上限，过期/缺失渲染安全占位). Uses the shared store;
 * lifecycle-safe: the URL is revoked on unmount / ref change.
 */
export function useBinaryRefObjectUrl(ref: BinaryRef | undefined): BinaryRefObjectUrlState {
  const [state, setState] = useState<BinaryRefObjectUrlState>({ url: null, failed: false });
  const key = ref ? `${ref.path}|${ref.sha256}|${ref.mimeType}` : '';
  useEffect(() => {
    if (!ref) {
      setState({ url: null, failed: false });
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    setState({ url: null, failed: false });
    getToolResultStore()
      .readBinaryBytes(ref)
      .then((bytes) => {
        if (revoked) return;
        if (!bytes) {
          setState({ url: null, failed: true });
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mimeType }));
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!revoked) setState({ url: null, failed: true });
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export { DEFAULT_TTL_MS as TOOL_CACHE_DEFAULT_TTL_MS };
