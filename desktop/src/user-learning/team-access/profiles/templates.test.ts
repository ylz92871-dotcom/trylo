// Builtin templates + signal mapping tests (Foundation spec §7.5).

import { describe, expect, it } from 'vitest';
import {
  builtinTemplate,
  builtinTemplateIdsForSurface,
  builtinTemplatesForSurface,
  isReviewOnlyTemplate,
  mapSignalsToTemplate,
} from './templates';
import { validateProfile } from './profile-validate';

describe('builtin templates', () => {
  it('code surface lists the 4 Code variants; work lists deliverable', () => {
    expect(builtinTemplateIdsForSurface('code')).toEqual([
      'small-change', 'architecture', 'verify-only', 'review-only',
    ]);
    expect(builtinTemplateIdsForSurface('work')).toEqual([
      'small-change', 'architecture', 'deliverable', 'review-only',
    ]);
  });

  it('rosters match §7.5 (person first; review-only has no worker)', () => {
    const architecture = builtinTemplate('architecture', 'code');
    expect(architecture.members.map((m) => m.baseRole)).toEqual([
      'person', 'architect', 'worker', 'reviewer', 'verifier',
    ]);
    const reviewOnly = builtinTemplate('review-only', 'code');
    expect(reviewOnly.members.map((m) => m.baseRole)).toEqual(['person', 'reviewer']);
    expect(isReviewOnlyTemplate(reviewOnly.id)).toBe(true);
  });

  it('every builtin validates under its own worker rule', () => {
    for (const surface of ['code', 'work'] as const) {
      for (const template of builtinTemplatesForSurface(surface)) {
        const result = validateProfile(
          { members: template.members, title: template.title },
          { allowNoWorker: isReviewOnlyTemplate(template.id) },
        );
        expect(result).toEqual({ ok: true });
      }
    }
  });

  it('builtins are marked builtin and their overlays default to inherit/empty', () => {
    const t = builtinTemplate('small-change', 'code');
    expect(t.origin).toBe('builtin');
    for (const m of t.members) {
      expect(m.overlay.model).toBe('inherit');
      expect(m.overlay.skills).toEqual([]);
      expect(m.overlay.systemPromptOverlay).toBe('');
    }
  });
});

describe('mapSignalsToTemplate (auto-assemble mapping, never spawns)', () => {
  it('review-only intent without implementation verbs', () => {
    expect(mapSignalsToTemplate({ prompt: '看看 diff，只审一下', product: 'code' })).toBe('review-only');
    expect(mapSignalsToTemplate({ prompt: 'review this PR', product: 'code' })).toBe('review-only');
  });

  it('corePath / high risk / architecture wording → architecture', () => {
    expect(mapSignalsToTemplate({ prompt: '迁移持久化层', product: 'code', corePath: true })).toBe('architecture');
    expect(mapSignalsToTemplate({ prompt: '实现导出', product: 'code', risk: 'high' })).toBe('architecture');
    expect(mapSignalsToTemplate({ prompt: '整体重构跨模块', product: 'code' })).toBe('architecture');
  });

  it('work product or deliverable wording → deliverable / verify-only', () => {
    expect(mapSignalsToTemplate({ prompt: '把数据整理成报告', product: 'work' })).toBe('deliverable');
    expect(mapSignalsToTemplate({ prompt: '补测试并验证', product: 'code' })).toBe('verify-only');
  });

  it('everything else defaults to small-change', () => {
    expect(mapSignalsToTemplate({ prompt: '修一下这个导出路径', product: 'code' })).toBe('small-change');
  });
});
