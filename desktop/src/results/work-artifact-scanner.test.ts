// Trylo Desktop — Work artifact scanner isolation tests
// (P2-1 Work Package B + C-Edge P2-3 filesystem boundary hardening).
// Attachments live under `.trylo/attachments/` and artifacts under
// `.trylo/out/`; the two domains must never mix. The scanner is
// structurally rooted at `.trylo/out`, so a staged attachment can never
// become an artifact.
//
// The eligibility invariant is `isFile === true`. Every non-regular
// entry (directory / symlink / reparse / special / unknown) MUST be
// dropped — this is the audit's P2-3 closure.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const scanTreeMock = vi.fn();

vi.mock('../host-adapter/index', () => ({
  hostAdapter: {
    fs: {
      scanTree: (...args: unknown[]) => scanTreeMock(...args),
    },
  },
}));

import { artifactFromStat, scanWorkOutput } from './work-artifact-scanner';
import type { FilePath } from '../host-adapter/types';

const ROOT = 'D:/projects/alpha';
const OUT = `${ROOT}/.trylo/out`;

/** Build a regular-file FileStat for a path. */
function file(path: string, size = 10): { path: string; size: number; modifiedMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean } {
  return { path, size, modifiedMs: 1, isDirectory: false, isFile: true, isSymlink: false };
}

/** Build a directory entry. */
function dir(path: string): { path: string; size: number; modifiedMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean } {
  return { path, size: 0, modifiedMs: 1, isDirectory: true, isFile: false, isSymlink: false };
}

/** Build a symlink entry (the host reports isSymlink=true). */
function symlink(path: string): { path: string; size: number; modifiedMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean } {
  return { path, size: 0, modifiedMs: 1, isDirectory: false, isFile: false, isSymlink: true };
}

/** A Unix socket / FIFO / device / unknown special entry: not a file,
 *  not a directory, not a symlink. `isFile=false` is what the scanner
 *  keys on. */
function special(path: string): { path: string; size: number; modifiedMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean } {
  return { path, size: 0, modifiedMs: 1, isDirectory: false, isFile: false, isSymlink: false };
}

beforeEach(() => {
  scanTreeMock.mockReset();
});

describe('scanWorkOutput — attachment/artifact domain separation', () => {
  it('roots the scan at .trylo/out (attachments dir is never scanned)', async () => {
    scanTreeMock.mockResolvedValueOnce({ files: [], truncated: false, warnings: [] });
    await scanWorkOutput(ROOT as FilePath);
    expect(scanTreeMock).toHaveBeenCalledTimes(1);
    expect(scanTreeMock.mock.calls[0]![0]).toBe(`${ROOT}/.trylo/out`);
    expect(String(scanTreeMock.mock.calls[0]![0])).not.toContain('attachments');
  });

  it('scan results never carry .trylo/attachments paths', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [file(`${OUT}/report.md`)],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    expect(outcome.artifacts.length).toBe(1);
    for (const artifact of outcome.artifacts) {
      expect(artifact.target.kind).toBe('file');
      if (artifact.target.kind === 'file') {
        expect(artifact.target.relativePath).not.toContain('.trylo/attachments');
      }
      expect(artifact.absolutePath).not.toContain('.trylo/attachments');
    }
  });

  it('artifactFromStat refuses to project a staged attachment as an artifact of the OUT scan', () => {
    const outRoot = `${ROOT}/.trylo/out`;
    const attachment = artifactFromStat(
      { path: `${ROOT}/.trylo/attachments/conv-1/att_1/spec.md`, size: 10, modifiedMs: 1 },
      outRoot,
    );
    expect(attachment).toBeUndefined();
  });

  it('artifactFromStat projects regular out files normally', () => {
    const artifact = artifactFromStat(
      { path: `${OUT}/report.md`, size: 10, modifiedMs: 1 },
      ROOT,
    );
    expect(artifact).toBeDefined();
    expect(artifact!.target.kind).toBe('file');
    if (artifact!.target.kind === 'file') {
      expect(artifact!.target.relativePath).toBe('.trylo/out/report.md');
    }
  });
});

describe('scanWorkOutput — filesystem eligibility invariant (C-Edge P2-3)', () => {
  it('accepts a regular file under .trylo/out', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [file(`${OUT}/report.md`, 20)],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    expect(outcome.artifacts.length).toBe(1);
    expect(outcome.artifacts[0]!.target).toEqual({
      kind: 'file',
      relativePath: '.trylo/out/report.md',
    });
  });

  it('drops directory entries even when they look like a name', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [dir(`${OUT}/sub`), file(`${OUT}/sub/inner.md`)],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    // Only the inner file passes; the directory is dropped.
    expect(outcome.artifacts.length).toBe(1);
    expect(outcome.artifacts[0]!.target).toEqual({
      kind: 'file',
      relativePath: '.trylo/out/sub/inner.md',
    });
  });

  it('drops symlink entries (isSymlink=true) — never follows the link target', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${OUT}/real.md`, 10),
        symlink(`${OUT}/link.md`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    const paths = outcome.artifacts.map((a) =>
      a.target.kind === 'file' ? a.target.relativePath : '',
    );
    expect(paths).toEqual(['.trylo/out/real.md']);
  });

  it('drops reparse-point-style entries (isFile=false, isDirectory=false, isSymlink=false)', async () => {
    // Windows reparse points that surface as neither file nor directory
    // are reported this way by the host. The invariant must still drop
    // them — a symlink target's own stat is the host's job, not ours.
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${OUT}/real.md`, 10),
        special(`${OUT}/odd-thing`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    expect(outcome.artifacts.length).toBe(1);
    expect(outcome.artifacts[0]!.target).toEqual({
      kind: 'file',
      relativePath: '.trylo/out/real.md',
    });
  });

  it('drops Unix-socket / FIFO / device entries (isFile=false)', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [special(`${OUT}/pipe`), file(`${OUT}/notes.md`)],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    expect(outcome.artifacts.length).toBe(1);
    expect(outcome.artifacts[0]!.target).toEqual({
      kind: 'file',
      relativePath: '.trylo/out/notes.md',
    });
  });

  it('drops a staged-attachment path even if the host somehow surfaces it', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${ROOT}/.trylo/attachments/conv-1/att_1/spec.md`, 10),
        file(`${OUT}/keep.md`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    const rels = outcome.artifacts.map((a) =>
      a.target.kind === 'file' ? a.target.relativePath : '',
    );
    expect(rels).toEqual(['.trylo/out/keep.md']);
  });

  it('drops entries that fall outside the OUT root (defense in depth)', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${OUT}/keep.md`),
        // A path that pretends to be inside OUT but the host surfaced
        // a sibling that escaped the scan boundary.
        file(`${ROOT}/somewhere-else.md`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    const rels = outcome.artifacts.map((a) =>
      a.target.kind === 'file' ? a.target.relativePath : '',
    );
    expect(rels).toEqual(['.trylo/out/keep.md']);
  });

  it('still discovers a nested legitimate artifact several levels deep', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${OUT}/a/b/c/deep.md`, 5),
        symlink(`${OUT}/a/b/c/link.md`),
        dir(`${OUT}/a/b/c/sub`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    expect(outcome.artifacts.length).toBe(1);
    expect(outcome.artifacts[0]!.target).toEqual({
      kind: 'file',
      relativePath: '.trylo/out/a/b/c/deep.md',
    });
  });

  it('loop-internal filenames are still excluded by name', async () => {
    scanTreeMock.mockResolvedValueOnce({
      files: [
        file(`${OUT}/loop-trylo-system.log`, 10),
        file(`${OUT}/report.md`),
      ],
      truncated: false,
      warnings: [],
    });
    const outcome = await scanWorkOutput(ROOT as FilePath);
    const rels = outcome.artifacts.map((a) =>
      a.target.kind === 'file' ? a.target.relativePath : '',
    );
    expect(rels).toEqual(['.trylo/out/report.md']);
  });
});
