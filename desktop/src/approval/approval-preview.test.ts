// Trylo Desktop — ApprovalPreview tests (P3, spec §4.6).
//
// The preview builder is the firewall between untrusted tool
// input and the React tree. Any drift here can leak the full
// proposed content into the chat stream or pretend to have a
// diff for a path that escapes the project root.

import { describe, expect, it } from 'vitest';
import {
  buildApprovalPreview,
  safeRelativePath,
  type ApprovalDiffPreview,
} from './approval-preview';
import type { FilePath } from '../host-adapter/types';

const ROOT = 'C:/work/demo-ws' as FilePath;

describe('approval-preview', () => {
  describe('safeRelativePath', () => {
    it('accepts a clean relative path', () => {
      expect(safeRelativePath('src/foo.ts', ROOT)).toBe('src/foo.ts');
    });
    it('rejects absolute Windows paths', () => {
      expect(safeRelativePath('C:/Windows/System32/cmd.exe', ROOT)).toBeNull();
    });
    it('rejects absolute POSIX paths', () => {
      expect(safeRelativePath('/etc/passwd', ROOT)).toBeNull();
    });
    it('rejects path traversal that escapes the root', () => {
      // ../../etc/passwd — depth goes below zero.
      expect(safeRelativePath('../../etc/passwd', ROOT)).toBeNull();
    });
    it('rejects embedded drive letters', () => {
      expect(safeRelativePath('src/C:bad.ts', ROOT)).toBeNull();
    });
    it('rejects an empty path', () => {
      expect(safeRelativePath('', ROOT)).toBeNull();
    });
    it('normalizes redundant separators', () => {
      expect(safeRelativePath('src//foo.ts', ROOT)).toBe('src/foo.ts');
    });
  });

  describe('buildApprovalPreview — Write', () => {
    it('builds a diff preview for a new file with full content', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Write',
        input: {
          file_path: 'src/new.ts',
          content: 'export const x = 1;\nexport const y = 2;\n',
        },
        projectRoot: ROOT,
        readFile: async () => null,
      });
      expect(preview.kind).toBe('diff');
      expect(preview.target).toBe('src/new.ts');
      const diff = preview.diff as ApprovalDiffPreview;
      expect(diff.path).toBe('src/new.ts');
      expect(diff.modified).toContain('export const x');
      expect(diff.additions).toBeGreaterThan(0);
    });

    it('replaces existing file content (safe path) and reports insertions', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Write',
        input: {
          file_path: 'src/old.ts',
          content: 'A\nB\nC\nD\n',
        },
        projectRoot: ROOT,
        readFile: async () => 'A\nC\n',
      });
      expect(preview.kind).toBe('diff');
      const diff = preview.diff as ApprovalDiffPreview;
      expect(diff.additions).toBeGreaterThanOrEqual(2);
    });

    it('rejects paths outside the project root', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Write',
        input: {
          file_path: '../../../etc/passwd',
          content: 'whatever',
        },
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('summary');
      expect(preview.reason).toMatch(/项目外|未生成预览/);
    });

    it('returns unavailable when file_path is missing', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Write',
        input: { content: 'x' },
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('unavailable');
    });
  });

  describe('buildApprovalPreview — Edit', () => {
    it('replaces old_string with new_string inside the original content', async () => {
      const original = 'const a = 1;\nconst b = 2;\n';
      const preview = await buildApprovalPreview({
        toolName: 'Edit',
        input: {
          file_path: 'src/edit.ts',
          old_string: 'const a = 1;',
          new_string: 'const a = 999;',
        },
        projectRoot: ROOT,
        readFile: async () => original,
      });
      expect(preview.kind).toBe('diff');
      const diff = preview.diff as ApprovalDiffPreview;
      expect(diff.modified).toContain('const a = 999;');
      expect(diff.modified).toContain('const b = 2;');
    });

    it('falls back to the proposed new content when the anchor is missing', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Edit',
        input: {
          file_path: 'src/edit.ts',
          old_string: 'will-not-match',
          new_string: 'PROPOSED',
        },
        projectRoot: ROOT,
        readFile: async () => 'something else',
      });
      expect(preview.kind).toBe('diff');
      const diff = preview.diff as ApprovalDiffPreview;
      expect(diff.modified).toContain('PROPOSED');
    });
  });

  describe('buildApprovalPreview — Bash', () => {
    it('summarises the command and optional cwd', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Bash',
        input: { command: 'pnpm test', cwd: 'C:/work/demo-ws/desktop' },
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('command');
      expect(preview.command).toBe('pnpm test');
      expect(preview.cwd).toBe('C:/work/demo-ws/desktop');
    });

    it('returns unavailable when the command field is missing', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'Bash',
        input: {},
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('unavailable');
    });
  });

  describe('buildApprovalPreview — unknown tools', () => {
    it('returns unavailable for unsupported tool names', async () => {
      const preview = await buildApprovalPreview({
        toolName: 'SomeMadeUpTool',
        input: { whatever: true },
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('unavailable');
      expect(preview.reason).toMatch(/可预览/);
    });

    it('does not throw on malformed input', async () => {
      // null, arrays, primitives — must not crash the parser pipeline.
      const result = await buildApprovalPreview({
        toolName: 'Write',
        input: { file_path: null, content: 12345 } as unknown as Record<string, unknown>,
        projectRoot: ROOT,
      });
      expect(result.kind).toBe('unavailable');
    });
  });

  describe('truncation', () => {
    it('marks the preview truncated when content exceeds the byte cap', async () => {
      const big = 'x'.repeat(64);
      const preview = await buildApprovalPreview({
        toolName: 'Write',
        input: { file_path: 'src/big.ts', content: big },
        projectRoot: ROOT,
        readFile: async () => '',
        maxBytes: 16,
      });
      expect(preview.kind).toBe('diff');
      const diff = preview.diff as ApprovalDiffPreview;
      expect(diff.truncated).toBe(true);
    });
  });

  describe('buildApprovalPreview — classifier-managed MCP tools (PR-2, §12.2)', () => {
    const OFFICECLI = 'mcp__trylo-office__officecli';

    it('renders a safe summary for the officecli tool', async () => {
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: { command: 'set', file: 'docs/report.docx' },
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('summary');
      expect(preview.title).toBe('Office 文档操作');
      expect(preview.target).toContain('set');
      expect(preview.target).toContain('docs/report.docx');
    });

    it('shows workspace-relative paths for in-root targets', async () => {
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: { command: 'create', output: 'C:/work/demo-ws/.trylo/out/report.docx' },
        projectRoot: ROOT,
      });
      expect(preview.target).toContain('.trylo/out/report.docx');
    });

    it('never echoes document content fields', async () => {
      const secret = 'CONFIDENTIAL-BODY-TEXT';
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: { command: 'create', output: '.trylo/out/a.docx', content: secret },
        projectRoot: ROOT,
      });
      expect(JSON.stringify(preview)).not.toContain(secret);
    });

    it('marks an out-of-root path instead of dropping it silently', async () => {
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: { command: 'view', file: 'C:/elsewhere/a.docx' },
        projectRoot: ROOT,
      });
      expect(preview.target).toContain('工作区外');
    });

    it('describes a batch with its sub-command count', async () => {
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: {
          command: 'batch',
          batch: [{ command: 'view', file: 'a.docx' }, { command: 'get', file: 'b.docx' }],
        },
        projectRoot: ROOT,
      });
      expect(preview.target).toContain('batch');
      expect(preview.reason).toContain('2');
    });

    it('does not throw on garbage input', async () => {
      const preview = await buildApprovalPreview({
        toolName: OFFICECLI,
        input: { command: 42, file: ['x'] } as unknown as Record<string, unknown>,
        projectRoot: ROOT,
      });
      expect(preview.kind).toBe('summary');
    });
  });
});
