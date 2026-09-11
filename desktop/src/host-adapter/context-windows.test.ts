// Trylo Desktop — context-window model map + format helpers.
// See v1.16.0 + host-adapter/context-windows.ts.

import { describe, expect, it } from 'vitest';
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  formatTokenCountFull,
  formatTokenCountShort,
} from './context-windows';

describe('contextWindowFor', () => {
  it('returns 200k for known Claude 3.5 Sonnet aliases', () => {
    expect(contextWindowFor('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(contextWindowFor('claude-3-5-sonnet-latest')).toBe(200_000);
  });

  it('returns 200k for Claude 4 family', () => {
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-1')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4')).toBe(200_000);
  });

  it('returns 200k for Claude 3.7 Sonnet', () => {
    expect(contextWindowFor('claude-3-7-sonnet-20250219')).toBe(200_000);
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW for unknown models', () => {
    expect(contextWindowFor('gpt-4o')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor('gemini-2.0-flash')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor('totally-made-up-model')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('handles null / undefined / empty input gracefully', () => {
    expect(contextWindowFor(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor('')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('is case-insensitive', () => {
    expect(contextWindowFor('CLAUDE-OPUS-4')).toBe(200_000);
    expect(contextWindowFor('Claude-3-5-Sonnet')).toBe(200_000);
  });
});

describe('formatTokenCountShort', () => {
  it('returns "0" for 0 and negatives', () => {
    expect(formatTokenCountShort(0)).toBe('0');
    expect(formatTokenCountShort(-5)).toBe('0');
  });

  it('returns raw number under 1000', () => {
    expect(formatTokenCountShort(1)).toBe('1');
    expect(formatTokenCountShort(999)).toBe('999');
  });

  it('formats thousands with k suffix (always integer)', () => {
    expect(formatTokenCountShort(1_000)).toBe('1k');
    expect(formatTokenCountShort(1_234)).toBe('1k');
    expect(formatTokenCountShort(9_999)).toBe('10k');
    expect(formatTokenCountShort(47_231)).toBe('47k');
    expect(formatTokenCountShort(199_500)).toBe('200k');
  });

  it('formats millions with M suffix (always integer)', () => {
    expect(formatTokenCountShort(1_000_000)).toBe('1M');
    expect(formatTokenCountShort(1_234_567)).toBe('1M');
    expect(formatTokenCountShort(12_345_678)).toBe('12M');
  });

  it('handles NaN / Infinity by returning "0"', () => {
    expect(formatTokenCountShort(NaN)).toBe('0');
    expect(formatTokenCountShort(Infinity)).toBe('0');
  });
});

describe('formatTokenCountFull', () => {
  it('returns locale-separated string with commas', () => {
    expect(formatTokenCountFull(1)).toBe('1');
    expect(formatTokenCountFull(1_234)).toBe('1,234');
    expect(formatTokenCountFull(47_231)).toBe('47,231');
    expect(formatTokenCountFull(200_000)).toBe('200,000');
    expect(formatTokenCountFull(1_234_567)).toBe('1,234,567');
  });

  it('returns "0" for 0 / negative / NaN / Infinity', () => {
    expect(formatTokenCountFull(0)).toBe('0');
    expect(formatTokenCountFull(-10)).toBe('0');
    expect(formatTokenCountFull(NaN)).toBe('0');
    expect(formatTokenCountFull(Infinity)).toBe('0');
  });
});
