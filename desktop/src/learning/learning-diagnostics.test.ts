// learning-diagnostics.ts：学习诊断 sink（TRYLO-DUAL-SURFACE-SPEC §Observability）。

import { describe, it, expect } from 'vitest';
import { createLearningDiagnostics, redactWorkPath } from './learning-diagnostics';

describe('createLearningDiagnostics', () => {
  it('records events and never lets a task body leak into the JSON', () => {
    const { sink, exportJson } = createLearningDiagnostics();
    sink.record({ type: 'learning.work_review_triggered', product: 'work', reasonCode: 'both' });
    sink.record({
      type: 'learning.work_review_skipped',
      path: '.trylo/out/周报.pptx', // already redacted
    });
    const json = exportJson();
    expect(json).toContain('learning.work_review_triggered');
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
  });

  it('redacts absolute task output paths out of the JSON', () => {
    const { sink, exportJson } = createLearningDiagnostics();
    const leaked = 'C:/work/demo-ws/.trylo/out/q3-deck.pptx';
    sink.record({ type: 'learning.template_copy', path: redactWorkPath(leaked) ?? undefined });
    const json = exportJson();
    expect(json).not.toContain('C:/work/demo-ws');
    expect(json).toContain('.trylo/out/q3-deck.pptx');
  });
});

describe('redactWorkPath', () => {
  it('keeps only .trylo/out/<basename>', () => {
    expect(redactWorkPath('d:/repo/.trylo/out/周报.pptx')).toBe('.trylo/out/周报.pptx');
    expect(redactWorkPath('d:/repo/.trylo/out/sub/notes.md')).toBe('.trylo/out/notes.md');
  });

  it('returns null for paths outside .trylo/out', () => {
    expect(redactWorkPath('d:/repo/src/main.ts')).toBeNull();
    expect(redactWorkPath('d:/repo/.trylo/cache/x.bin')).toBeNull();
  });
});