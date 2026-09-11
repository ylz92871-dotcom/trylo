// Trylo Desktop — partitioned conversation attachment store tests
// (P2-1 Work Package B).
//
// The store is the single source of truth for attachments of EVERY
// conversation, strictly partitioned by
// `{ surface, projectKey, conversationId }`. These tests pin:
//
//   - Ownership isolation (Work→Code, Code→Work, project A→B,
//     conversation A→B)
//   - Picker + drop flow through the same pipeline
//   - Conservative send semantics (the store exposes NO send-time
//     mutation — snapshots survive repeated reads)
//   - Deletion cleanup (conversation delete, project purge) + blob
//     revocation
//   - Work metadata persistence hook + restore-with-validation
//   - Late-completion protection (navigation mid-acquisition)

import { describe, expect, it } from 'vitest';
import {
  ConversationAttachmentStore,
  ownerKey,
  type AttachmentOwner,
  type AttachmentStoreDeps,
} from './conversation-attachment-store';
import type { LiveIdentity } from './attachment-acquisition';
import type { StageAttachmentArgs, StagedAttachment } from '../host-adapter/attachment-service';

const ROOT_A = 'D:/projects/alpha';

const CODE_A: AttachmentOwner = { surface: 'code', projectKey: 'projA', conversationId: 'code-a' };
const CODE_B: AttachmentOwner = { surface: 'code', projectKey: 'projA', conversationId: 'code-b' };
const WORK_A: AttachmentOwner = { surface: 'work', projectKey: 'projA', conversationId: 'work-a' };
const WORK_B: AttachmentOwner = { surface: 'work', projectKey: 'projB', conversationId: 'work-a' };

interface Harness {
  store: ConversationAttachmentStore;
  live: LiveIdentity | null;
  root: string | null;
  blobUrls: string[];
  revoked: string[];
  pickedPaths: string[];
  workChanged: Array<{ owner: AttachmentOwner; entries: readonly unknown[] }>;
  stageBehavior: (args: StageAttachmentArgs) => Promise<StagedAttachment>;
  missingStaged: Set<string>;
  sizes: Map<string, number>;
  statOverrides: Map<string, { size: number; isDirectory?: boolean; isFile?: boolean; isSymlink?: boolean }>;
}

function makeHarness(): Harness {
  const harness: Harness = {
    store: null as unknown as ConversationAttachmentStore,
    live: null,
    root: ROOT_A,
    blobUrls: [],
    revoked: [],
    pickedPaths: [],
    workChanged: [],
    stageBehavior: async (args) => {
      const name = args.sourcePath.match(/[^/\\]+$/)?.[0] ?? 'attachment.bin';
      return {
        relativePath: `.trylo/attachments/${args.conversationId}/${args.attachmentId}/${name}`,
        name,
        size: 1024,
      };
    },
    missingStaged: new Set(),
    sizes: new Map(),
    statOverrides: new Map(),
  };
  const deps: AttachmentStoreDeps = {
    statFile: async (p) => {
      if (harness.missingStaged.has(p)) throw new Error(`not found: ${p}`);
      const override = harness.statOverrides.get(p);
      if (override) return override;
      return { size: harness.sizes.get(p) ?? 1024, isDirectory: false, isFile: true };
    },
    readText: async (p) => `text of ${p}`,
    readBytes: async (p) => new TextEncoder().encode(`bytes of ${p}`),
    createBlobUrl: (_bytes, _mime) => {
      const url = `blob:test/${harness.blobUrls.length + 1}`;
      harness.blobUrls.push(url);
      return url;
    },
    revokeBlobUrl: (url) => { harness.revoked.push(url); },
    pickFiles: async () => harness.pickedPaths,
    stageAttachment: (args) => harness.stageBehavior(args),
  };
  harness.store = new ConversationAttachmentStore(deps);
  harness.store.setRuntimeProviders({
    getLiveIdentity: () => harness.live,
    getWorkspaceRoot: () => harness.root,
    onWorkAttachmentsChanged: (owner, entries) => {
      harness.workChanged.push({ owner, entries });
    },
  });
  return harness;
}

function matchOwner(owner: AttachmentOwner): LiveIdentity {
  return {
    topMode: owner.surface,
    workspaceKey: owner.projectKey,
    conversationId: owner.conversationId,
  };
}

describe('ConversationAttachmentStore — partition isolation', () => {
  it('never leaks Work attachments into the Code partition of the same conversation', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/spec.md']);
    expect(h.store.snapshot(WORK_A).workAttachments.length).toBe(1);
    expect(h.store.snapshot(CODE_A).attachments).toEqual([]);
    expect(h.store.snapshot(CODE_A).workAttachments).toEqual([]);
  });

  it('never leaks Code attachments into the Work partition', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    await h.store.acquireByPaths(CODE_A, ['D:/ext/notes.md']);
    expect(h.store.snapshot(CODE_A).attachments.length).toBe(1);
    expect(h.store.snapshot(WORK_A).attachments).toEqual([]);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
  });

  it('keeps conversations of the same project disjoint', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    await h.store.acquireByPaths(CODE_A, ['D:/ext/a.md']);
    expect(h.store.snapshot(CODE_B).attachments).toEqual([]);
    expect(h.store.snapshot(CODE_A).attachments.length).toBe(1);
  });

  it('keeps the same conversation id disjoint across projects', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/a.md']);
    expect(ownerKey(WORK_A)).not.toBe(ownerKey(WORK_B));
    expect(h.store.snapshot(WORK_B).workAttachments).toEqual([]);
  });

  it('returns a stable empty snapshot for unknown keys', () => {
    const h = makeHarness();
    const one = h.store.snapshot(CODE_A);
    const two = h.store.snapshot(CODE_A);
    expect(one).toBe(two);
    expect(one.attachments).toEqual([]);
  });
});

describe('ConversationAttachmentStore — acquisition entry points', () => {
  it('routes picker picks through the same pipeline as drops', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    h.pickedPaths = ['D:/picked/doc.docx'];
    await h.store.openPicker(CODE_A);
    const snap = h.store.snapshot(CODE_A);
    expect(snap.attachments.length).toBe(1);
    expect(snap.attachments[0]!.name).toBe('doc.docx');
  });

  it('does nothing when the picker returns no paths', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    h.pickedPaths = [];
    await h.store.openPicker(CODE_A);
    expect(h.store.snapshot(CODE_A)).toBe(h.store.snapshot(CODE_A));
    expect(h.store.snapshot(CODE_A).attachments).toEqual([]);
  });

  it('stages work acquisitions and notifies the persistence hook once', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/report.docx']);
    const snap = h.store.snapshot(WORK_A);
    expect(snap.workAttachments.length).toBe(1);
    expect(snap.workAttachments[0]!.relativePath).toMatch(/^\.trylo\/attachments\/work-a\//);
    expect(h.workChanged.length).toBe(1);
    expect(h.workChanged[0]!.owner).toEqual(WORK_A);
    expect(h.workChanged[0]!.entries.length).toBe(1);
  });

  it('abandons an acquisition when the user navigates before commit', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    const promise = h.store.acquireByPaths(CODE_A, ['D:/ext/a.md', 'D:/ext/b.md']);
    // Navigate to another conversation while the pipeline awaits.
    h.live = matchOwner(CODE_B);
    await promise;
    // Nothing landed in EITHER partition's attachment list; the
    // abandonment is surfaced as a visible failure on the owner.
    expect(h.store.snapshot(CODE_A).attachments).toEqual([]);
    expect(h.store.snapshot(CODE_B).attachments).toEqual([]);
    expect(h.store.snapshot(CODE_A).failed.length).toBeGreaterThan(0);
  });

  it('surfaces oversize rejects as visible failures', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    h.sizes.set('D:/ext/huge.md', 99 * 1024 * 1024);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/huge.md']);
    const failed = h.store.snapshot(WORK_A).failed;
    expect(failed.length).toBe(1);
    expect(failed[0]!.reason).toMatch(/too large/i);
    expect(failed[0]!.retryable).toBeUndefined();
  });

  it('retries a retryable failure through retryFailed', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    let attempts = 0;
    h.stageBehavior = async (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('io error on copy: file busy');
      const name = args.sourcePath.match(/[^/\\]+$/)?.[0] ?? 'attachment.bin';
      return {
        relativePath: `.trylo/attachments/${args.conversationId}/${args.attachmentId}/${name}`,
        name,
        size: 1024,
      };
    };
    await h.store.acquireByPaths(WORK_A, ['D:/ext/a.md']);
    expect(h.store.snapshot(WORK_A).failed.length).toBe(1);
    expect(h.store.snapshot(WORK_A).failed[0]!.retryable).toBe(true);
    const failedId = h.store.snapshot(WORK_A).failed[0]!.id;
    h.store.retryFailed(WORK_A, failedId);
    // Retry runs async through acquireByPaths.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.snapshot(WORK_A).failed).toEqual([]);
    expect(h.store.snapshot(WORK_A).workAttachments.length).toBe(1);
  });
});

describe('ConversationAttachmentStore — conservative send semantics', () => {
  it('keeps attachments across repeated snapshot reads (sending never clears)', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/a.md']);
    // A send consumes a snapshot; the store itself exposes no
    // send-time mutation — the entries must survive intact.
    const first = h.store.snapshot(WORK_A).workAttachments;
    const second = h.store.snapshot(WORK_A).workAttachments;
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });
});

describe('ConversationAttachmentStore — cleanup + blob lifecycle', () => {
  it('revokes the preview blob when a code attachment is removed', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    await h.store.acquireByPaths(CODE_A, ['D:/ext/photo.png']);
    const snap = h.store.snapshot(CODE_A);
    expect(snap.attachments[0]!.previewUrl).toBe('blob:test/1');
    h.store.remove(CODE_A, snap.attachments[0]!.id);
    expect(h.store.snapshot(CODE_A).attachments).toEqual([]);
    expect(h.revoked).toEqual(['blob:test/1']);
  });

  it('revokes the preview blob when a work attachment is removed', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/photo.png']);
    const entry = h.store.snapshot(WORK_A).workAttachments[0]!;
    expect(entry.previewUrl).toBe('blob:test/1');
    h.store.remove(WORK_A, entry.id);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
    expect(h.revoked).toEqual(['blob:test/1']);
    // Removal persists through the hook (empty entries list).
    expect(h.workChanged.at(-1)!.entries.length).toBe(0);
  });

  it('clearConversation drops the partition and revokes every blob', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/photo.png', 'D:/ext/a.md']);
    expect(h.store.snapshot(WORK_A).workAttachments.length).toBe(2);
    h.store.clearConversation(WORK_A);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
    expect(h.revoked).toContain('blob:test/1');
  });

  it('purgeProject drops every surface of the project only', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    await h.store.acquireByPaths(CODE_A, ['D:/ext/a.md']);
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/b.md']);
    h.live = matchOwner(WORK_B);
    await h.store.acquireByPaths(WORK_B, ['D:/ext/c.md']);
    h.store.purgeProject('projA');
    expect(h.store.snapshot(CODE_A).attachments).toEqual([]);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
    // Other project untouched.
    expect(h.store.snapshot(WORK_B).workAttachments.length).toBe(1);
  });

  it('dismissFailed removes one failure chip', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    h.stageBehavior = async () => { throw new Error('io error on copy: busy'); };
    await h.store.acquireByPaths(WORK_A, ['D:/ext/a.md']);
    const failed = h.store.snapshot(WORK_A).failed;
    expect(failed.length).toBe(1);
    h.store.dismissFailed(WORK_A, failed[0]!.id);
    expect(h.store.snapshot(WORK_A).failed).toEqual([]);
  });

  it('caps the session at the max count and turns overflow into failures', async () => {
    const h = makeHarness();
    h.live = matchOwner(WORK_A);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/a.md', 'D:/ext/b.md', 'D:/ext/c.md', 'D:/ext/d.md']);
    await h.store.acquireByPaths(WORK_A, ['D:/ext/e.md', 'D:/ext/f.md', 'D:/ext/g.md']);
    const snap = h.store.snapshot(WORK_A);
    expect(snap.workAttachments.length).toBe(6);
    expect(snap.failed.length).toBe(1);
    expect(snap.failed[0]!.reason).toMatch(/max 6/i);
  });
});

describe('ConversationAttachmentStore — Work restore (restart recovery)', () => {
  it('restores persisted entries whose staged files still exist', async () => {
    const h = makeHarness();
    await h.store.restoreWork(WORK_A, ROOT_A, [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-a/att_1/a.md', mediaType: 'text/markdown', size: 10 },
      { id: 'att_2', name: 'b.md', relativePath: '.trylo/attachments/work-a/att_2/b.md', mediaType: 'text/markdown', size: 20 },
    ]);
    const snap = h.store.snapshot(WORK_A);
    expect(snap.workAttachments.length).toBe(2);
    expect(snap.workAttachments.map((w) => w.id)).toEqual(['att_1', 'att_2']);
  });

  it('drops persisted entries whose staged file is missing', async () => {
    const h = makeHarness();
    h.missingStaged.add(`${ROOT_A}/.trylo/attachments/work-a/att_2/b.md`);
    await h.store.restoreWork(WORK_A, ROOT_A, [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-a/att_1/a.md', mediaType: 'text/markdown', size: 10 },
      { id: 'att_2', name: 'b.md', relativePath: '.trylo/attachments/work-a/att_2/b.md', mediaType: 'text/markdown', size: 20 },
    ]);
    const snap = h.store.snapshot(WORK_A);
    expect(snap.workAttachments.length).toBe(1);
    expect(snap.workAttachments[0]!.id).toBe('att_1');
  });

  it('drops restored symlinks, reparse points, and other non-files', async () => {
    const h = makeHarness();
    const staged = `${ROOT_A}/.trylo/attachments/work-a/att_1/a.md`;
    h.statOverrides.set(staged, {
      size: 10,
      isDirectory: false,
      isFile: false,
      isSymlink: true,
    });
    await h.store.restoreWork(WORK_A, ROOT_A, [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-a/att_1/a.md', mediaType: 'text/markdown', size: 10 },
    ]);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
  });

  it('drops a persisted path that does not belong to its owner and attachment id', async () => {
    const h = makeHarness();
    await h.store.restoreWork(WORK_A, ROOT_A, [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-b/att_1/a.md', mediaType: 'text/markdown', size: 10 },
      { id: 'att_2', name: 'b.md', relativePath: '.trylo/attachments/work-a/different-id/b.md', mediaType: 'text/markdown', size: 20 },
    ]);
    expect(h.store.snapshot(WORK_A).workAttachments).toEqual([]);
  });

  it('is idempotent when the same history is restored more than once', async () => {
    const h = makeHarness();
    const persisted = [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-a/att_1/a.md', mediaType: 'text/markdown', size: 10 },
    ] as const;
    await h.store.restoreWork(WORK_A, ROOT_A, persisted);
    await h.store.restoreWork(WORK_A, ROOT_A, persisted);
    expect(h.store.snapshot(WORK_A).workAttachments.map((entry) => entry.id)).toEqual(['att_1']);
  });

  it('restore never re-fires the persistence hook', async () => {
    const h = makeHarness();
    await h.store.restoreWork(WORK_A, ROOT_A, [
      { id: 'att_1', name: 'a.md', relativePath: '.trylo/attachments/work-a/att_1/a.md', mediaType: 'text/markdown', size: 10 },
    ]);
    expect(h.workChanged).toEqual([]);
  });

  it('restore with an empty list is a no-op', async () => {
    const h = makeHarness();
    await h.store.restoreWork(WORK_A, ROOT_A, []);
    expect(h.store.snapshot(WORK_A)).toEqual({
      attachments: [], workAttachments: [], failed: [], readingCount: 0,
    });
  });
});

describe('ConversationAttachmentStore — subscription contract', () => {
  it('notifies listeners on change and keeps snapshot references stable between changes', async () => {
    const h = makeHarness();
    h.live = matchOwner(CODE_A);
    let calls = 0;
    const unsubscribe = h.store.subscribe(CODE_A, () => { calls += 1; });
    await h.store.acquireByPaths(CODE_A, ['D:/ext/a.md']);
    expect(calls).toBeGreaterThan(0);
    const before = h.store.snapshot(CODE_A);
    const after = h.store.snapshot(CODE_A);
    expect(after).toBe(before); // useSyncExternalStore requirement
    unsubscribe();
  });
});
