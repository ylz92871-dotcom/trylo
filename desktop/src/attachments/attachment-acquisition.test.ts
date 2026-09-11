// Trylo Desktop — shared attachment acquisition pipeline tests
// (P2-1 Work Package B; migrated + extended from
// drag-drop-attach.test.ts, P2-1 A-Edge).
//
// Covers BOTH surfaces through the ONE pipeline:
//
//   Code (legacy behavior, unchanged):
//   - drop runs to completion (text excerpt + image blob preview)
//   - identity switch mid-pipeline → abandoned (conversation /
//     workspace / mode)
//   - stat error → visible soft failure, pipeline continues
//   - per-acquisition cap trims additions
//
//   Work (staging copy-in):
//   - drop flows through stageAttachment with the minted ids
//   - image preview reads the STAGED path, never the raw source
//   - directory / oversize / non-regular-file → visible,
//     NON-retryable failures
//   - transient staging errors → retryable failures
//   - missing workspace root / conversation → visible failures
//
// All tests inject controllable I/O stubs; no real filesystem, no
// React, no Tauri runtime.

import { describe, expect, it } from 'vitest';
import {
  isRetryableFailure,
  joinToRoot,
  runAttachmentAcquisition,
  toWorkDescriptor,
  workAttachmentToView,
  type AcquisitionIdentity,
  type LiveIdentity,
} from './attachment-acquisition';
import type { StageAttachmentArgs, StagedAttachment } from '../host-adapter/attachment-service';

const CONV_A = 'conv-a';
const CONV_B = 'conv-b';
const WS_FOO = 'ws-FOO';
const WS_BAR = 'ws-BAR';
const ROOT = 'D:/projects/foo';

interface LiveState {
  topMode: 'code' | 'work';
  workspaceKey: string;
  conversationId: string | null;
}

function live(state: LiveState): () => LiveIdentity {
  return () => ({
    topMode: state.topMode,
    workspaceKey: state.workspaceKey,
    conversationId: state.conversationId,
  });
}

function identityOf(state: LiveState, sequence: number): AcquisitionIdentity {
  return { ...state, sequence };
}

interface FakeIO {
  statCalls: string[];
  readTextCalls: string[];
  readBytesCalls: string[];
  stageCalls: StageAttachmentArgs[];
  blobUrls: string[];
  /** Per-path size in bytes; defaults to 1024. */
  sizes: Record<string, number>;
  /** Per-path directory flag. */
  directories: Record<string, boolean>;
  /** When true, `statFile` yields extra microtask hops so a test can
   *  flip the live identity while the pipeline is awaiting. */
  delayStat: boolean;
  /** When true, `stageAttachment` yields extra microtask hops. */
  delayStage: boolean;
  /** Stage error to throw for every stage call. */
  stageError?: string;
}

function makeIO(overrides?: Partial<FakeIO>): FakeIO {
  return {
    statCalls: [],
    readTextCalls: [],
    readBytesCalls: [],
    stageCalls: [],
    blobUrls: [],
    sizes: {},
    directories: {},
    delayStat: false,
    delayStage: false,
    ...overrides,
  };
}

async function hop(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeStubs(io: FakeIO): {
  statFile: (p: string) => Promise<{ size: number; isDirectory?: boolean; isFile?: boolean }>;
  readText: (p: string) => Promise<string>;
  readBytes: (p: string) => Promise<Uint8Array>;
  createBlobUrl: (bytes: Uint8Array, mime: string) => string;
  stageAttachment: (args: StageAttachmentArgs) => Promise<StagedAttachment>;
} {
  return {
    statFile: async (p) => {
      io.statCalls.push(p);
      if (io.delayStat) await hop();
      return {
        size: io.sizes[p] ?? 1024,
        ...(io.directories[p] ? { isDirectory: true } : { isDirectory: false, isFile: true }),
      };
    },
    readText: async (p) => {
      io.readTextCalls.push(p);
      return `text content of ${p}`;
    },
    readBytes: async (p) => {
      io.readBytesCalls.push(p);
      return new TextEncoder().encode(`bytes of ${p}`);
    },
    createBlobUrl: (_bytes, _mime) => {
      const url = `blob:test/${io.blobUrls.length + 1}`;
      io.blobUrls.push(url);
      return url;
    },
    stageAttachment: async (args) => {
      io.stageCalls.push(args);
      if (io.delayStage) await hop();
      if (io.stageError) throw new Error(io.stageError);
      const name = args.sourcePath.match(/[^/\\]+$/)?.[0] ?? 'attachment.bin';
      return {
        relativePath: `.trylo/attachments/${args.conversationId}/${args.attachmentId}/${name}`,
        name,
        size: io.sizes[args.sourcePath] ?? 1024,
      };
    },
  };
}

function runCode(state: LiveState, getLiveIdentity: () => LiveIdentity, io: FakeIO,
  paths: readonly string[], overrides?: Partial<Parameters<typeof runAttachmentAcquisition>[0]>) {
  return runAttachmentAcquisition({
    surface: 'code',
    identity: identityOf(state, 1),
    getLiveIdentity,
    workspaceRoot: ROOT,
    paths,
    ...makeStubs(io),
    ...overrides,
  });
}

function runWork(state: LiveState, getLiveIdentity: () => LiveIdentity, io: FakeIO,
  paths: readonly string[], overrides?: Partial<Parameters<typeof runAttachmentAcquisition>[0]>) {
  return runAttachmentAcquisition({
    surface: 'work',
    identity: identityOf(state, 1),
    getLiveIdentity,
    workspaceRoot: ROOT,
    paths,
    ...makeStubs(io),
    ...overrides,
  });
}

describe('runAttachmentAcquisition — Code surface (legacy behavior, unchanged)', () => {
  it('runs the Code drop to completion with no navigation', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO();
    const result = await runCode(state, live(state), io, ['D:/foo/notes.md', 'D:/foo/photo.png']);
    expect(result.abandonedForNavigation).toBe(false);
    expect(result.additions.length).toBe(2);
    expect(result.workAdditions).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.additions.map((a) => a.name).sort()).toEqual(['notes.md', 'photo.png']);
    // Text file got a text read; image file got a bytes read + blob URL.
    expect(io.readTextCalls).toEqual(['D:/foo/notes.md']);
    expect(io.readBytesCalls).toEqual(['D:/foo/photo.png']);
    expect(io.blobUrls.length).toBe(1);
    // Code never stages.
    expect(io.stageCalls).toEqual([]);
  });

  it('abandons a drop when the user switches conversation mid-pipeline', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ delayStat: true });
    const dropPromise = runCode(state, live(state), io, ['D:/foo/a.md', 'D:/foo/b.md', 'D:/foo/c.md']);
    // Flip the live identity to a different conversation while the
    // first stat await is in flight.
    await Promise.resolve();
    state.conversationId = CONV_B;
    const result = await dropPromise;
    expect(result.additions.length).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.some((f) =>
      /abandoned|conversation or workspace changed/i.test(f.reason)
    )).toBe(true);
    expect(result.abandonedForNavigation).toBe(true);
  });

  it('abandons a drop when the user switches workspace mid-pipeline', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ delayStat: true });
    const dropPromise = runCode(state, live(state), io, ['D:/foo/a.md']);
    await Promise.resolve();
    state.workspaceKey = WS_BAR;
    const result = await dropPromise;
    expect(result.additions.length).toBe(0);
    expect(result.abandonedForNavigation).toBe(true);
  });

  it('abandons a drop when the user switches to Work mode mid-pipeline', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ delayStat: true });
    const dropPromise = runCode(state, live(state), io, ['D:/foo/a.md']);
    await Promise.resolve();
    state.topMode = 'work';
    const result = await dropPromise;
    expect(result.additions.length).toBe(0);
    expect(result.abandonedForNavigation).toBe(true);
  });

  it('rejects paths with empty list as a no-op', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const result = await runCode(state, live(state), makeIO(), []);
    expect(result).toEqual({
      additions: [],
      workAdditions: [],
      failures: [],
      abandonedForNavigation: false,
    });
  });

  it('records a soft failure for a stat error and continues with the next file', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO();
    const failingStat = async (p: string): Promise<{ size: number }> => {
      if (p === 'D:/foo/broken.md') throw new Error('permission denied');
      io.statCalls.push(p);
      return { size: 1024 };
    };
    const result = await runCode(state, live(state), io,
      ['D:/foo/ok.md', 'D:/foo/broken.md', 'D:/foo/also-ok.md'],
      { statFile: failingStat });
    expect(result.additions.length).toBe(2);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.name).toBe('broken.md');
    expect(result.failures[0]!.reason).toMatch(/can't read file/);
  });

  it('respects the per-acquisition cap and trims the additions list', async () => {
    const state: LiveState = { topMode: 'code', workspaceKey: WS_FOO, conversationId: CONV_A };
    const paths = Array.from({ length: 10 }, (_, i) => `D:/foo/f${i}.md`);
    const result = await runCode(state, live(state), makeIO(), paths);
    expect(result.additions.length).toBe(6);
    expect(result.failures).toEqual([]);
  });
});

describe('runAttachmentAcquisition — Work surface (staging copy-in)', () => {
  it('runs the Work drop through staging with minted ids', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO();
    const result = await runWork(state, live(state), io, ['D:/ext/report.docx', 'D:/ext/spec.md']);
    expect(result.abandonedForNavigation).toBe(false);
    expect(result.additions).toEqual([]); // work never fills the code array
    expect(result.workAdditions.length).toBe(2);
    expect(result.failures).toEqual([]);
    expect(io.stageCalls.length).toBe(2);
    for (const call of io.stageCalls) {
      expect(call.workspaceRoot).toBe(ROOT);
      expect(call.conversationId).toBe(CONV_A);
      expect(call.attachmentId).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // Each attachment got its own id (no same-name clobber).
    expect(io.stageCalls[0]!.attachmentId).not.toBe(io.stageCalls[1]!.attachmentId);
    const entry = result.workAdditions.find((w) => w.name === 'spec.md')!;
    expect(entry.relativePath)
      .toBe(`.trylo/attachments/${CONV_A}/${io.stageCalls[1]!.attachmentId}/spec.md`);
    expect(entry.sourcePath).toBe('D:/ext/spec.md');
    // Text files are never excerpted on the work surface — only images
    // get a preview, read from the staged copy.
    expect(io.readTextCalls).toEqual([]);
    expect(io.readBytesCalls).toEqual([]);
  });

  it('reads image previews from the STAGED path, never the raw source', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO();
    const result = await runWork(state, live(state), io, ['D:/ext/photo.png']);
    expect(result.workAdditions.length).toBe(1);
    const staged = io.stageCalls[0]!;
    expect(io.readBytesCalls).toEqual([joinToRoot(ROOT,
      `.trylo/attachments/${CONV_A}/${staged.attachmentId}/photo.png`)]);
    expect(io.readBytesCalls[0]).not.toBe('D:/ext/photo.png');
    expect(result.workAdditions[0]!.previewUrl).toBe('blob:test/1');
  });

  it('fails a directory visibly and without retry', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ directories: { 'D:/ext/folder': true } });
    const result = await runWork(state, live(state), io, ['D:/ext/folder']);
    expect(result.workAdditions).toEqual([]);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.reason).toMatch(/directory/i);
    expect(result.failures[0]!.retryable).toBeUndefined();
    expect(io.stageCalls).toEqual([]);
  });

  it('fails an oversize file visibly and without retry', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ sizes: { 'D:/ext/huge.md': 99 * 1024 * 1024 } });
    const result = await runWork(state, live(state), io, ['D:/ext/huge.md']);
    expect(result.workAdditions).toEqual([]);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.reason).toMatch(/too large|limit/i);
    expect(result.failures[0]!.retryable).toBeUndefined();
    expect(io.stageCalls).toEqual([]);
  });

  it('marks a transient staging error retryable', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ stageError: 'io error on copy: The process cannot access the file' });
    const result = await runWork(state, live(state), io, ['D:/ext/a.md']);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.retryable).toBe(true);
  });

  it('marks a deterministic staging reject non-retryable', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ stageError: 'attachment rejected: file is too large for its kind' });
    const result = await runWork(state, live(state), io, ['D:/ext/a.md']);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.retryable).toBeUndefined();
  });

  it('fails every file visibly when no workspace is open', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO();
    const result = await runAttachmentAcquisition({
      surface: 'work',
      identity: identityOf(state, 1),
      getLiveIdentity: live(state),
      workspaceRoot: null,
      paths: ['D:/ext/a.md'],
      ...makeStubs(io),
    });
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.reason).toMatch(/no workspace/i);
    expect(io.statCalls).toEqual([]);
    expect(io.stageCalls).toEqual([]);
  });

  it('fails every file visibly when no work conversation is open', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: null };
    const io = makeIO();
    const result = await runWork(state, live(state), io, ['D:/ext/a.md']);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.reason).toMatch(/no work conversation/i);
    expect(io.stageCalls).toEqual([]);
  });

  it('abandons a work drop when the user navigates mid-staging', async () => {
    const state: LiveState = { topMode: 'work', workspaceKey: WS_FOO, conversationId: CONV_A };
    const io = makeIO({ delayStage: true });
    const dropPromise = runWork(state, live(state), io, ['D:/ext/a.md']);
    await Promise.resolve();
    state.conversationId = CONV_B;
    const result = await dropPromise;
    expect(result.workAdditions).toEqual([]);
    expect(result.abandonedForNavigation).toBe(true);
  });
});

describe('projection helpers', () => {
  it('toWorkDescriptor projects only prompt-safe fields', () => {
    const descriptor = toWorkDescriptor({
      id: 'att_1', kind: 'text', name: 'spec.md',
      sourcePath: 'D:/ext/spec.md',
      relativePath: '.trylo/attachments/conv-a/att_1/spec.md',
      size: 512, mediaType: 'text/markdown', addedAt: 100,
    });
    expect(descriptor).toEqual({
      id: 'att_1',
      name: 'spec.md',
      relativePath: '.trylo/attachments/conv-a/att_1/spec.md',
      mediaType: 'text/markdown',
      size: 512,
    });
    // The raw external path never reaches the prompt.
    expect(JSON.stringify(descriptor)).not.toContain('D:/ext');
  });

  it('workAttachmentToView maps onto the shared chip shape with the staged path', () => {
    const view = workAttachmentToView({
      id: 'att_1', kind: 'image', name: 'photo.png',
      sourcePath: 'D:/ext/photo.png',
      relativePath: '.trylo/attachments/conv-a/att_1/photo.png',
      size: 2048, mediaType: 'image/png', addedAt: 100, previewUrl: 'blob:x/1',
    });
    expect(view.path).toBe('.trylo/attachments/conv-a/att_1/photo.png');
    expect(view.excerpt).toBe('');
    expect(view.previewUrl).toBe('blob:x/1');
    expect(JSON.stringify(view)).not.toContain('D:/ext');
  });

  it('joinToRoot picks the separator that matches the root', () => {
    expect(joinToRoot('D:/proj', '.trylo/attachments/c/a/f.md'))
      .toBe('D:/proj/.trylo/attachments/c/a/f.md');
    expect(joinToRoot('D:\\proj', '.trylo/attachments/c/a/f.md'))
      .toBe('D:\\proj\\.trylo/attachments/c/a/f.md');
    expect(joinToRoot('D:/proj/', '.trylo/attachments/c/a/f.md'))
      .toBe('D:/proj/.trylo/attachments/c/a/f.md');
  });

  it('isRetryableFailure separates transient errors from deterministic rejects', () => {
    expect(isRetryableFailure('io error on copy: access denied')).toBe(true);
    expect(isRetryableFailure("can't read file: permission denied")).toBe(true);
    expect(isRetryableFailure('attachment rejected: file is too large')).toBe(false);
    expect(isRetryableFailure("Can't attach a directory")).toBe(false);
    expect(isRetryableFailure('attachment rejected: source is a symlink')).toBe(false);
    expect(isRetryableFailure('attachment rejected: invalid conversation id')).toBe(false);
    expect(isRetryableFailure('staged copy failed containment check')).toBe(false);
  });
});
