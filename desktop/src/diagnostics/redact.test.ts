// Trylo Desktop — diagnostic redaction tests (C-Edge P2-5).
//
// These tests pin the exact behaviour: every secret, email, and
// private-path shape must be stripped; env values must follow the
// whitelist; FNV-1a must be deterministic and have no obvious
// collisions on the sample inputs.

import { describe, expect, it } from 'vitest';
import { anonId, fnv1a32, redactEnv, redactPath, redactText } from './redact';

describe('redactText', () => {
  it('passes through short safe text unchanged', () => {
    expect(redactText('hello world')).toBe('hello world');
  });

  it('strips Bearer tokens', () => {
    expect(redactText('Authorization: Bearer abc123def456ghi789')).toBe(
      'Authorization: <redacted>',
    );
  });

  it('strips sk- style API keys', () => {
    expect(redactText('key=sk-1234567890abcdefghij')).toBe('key=<redacted>');
  });

  it('strips sk_ style API keys', () => {
    expect(redactText('found sk_live_1234567890abcdefghij in env')).toBe(
      'found <redacted> in env',
    );
  });

  it('strips x-api-key style header values', () => {
    expect(redactText('x-api-key: super-secret-value, x=1')).toBe(
      '<redacted>, x=1',
    );
  });

  it('strips PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const out = redactText(`key material follows: ${pem} done`);
    expect(out).not.toContain('BEGIN');
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('<redacted>');
    expect(out).toContain('done');
  });

  it('strips email addresses', () => {
    expect(redactText('contact me at user@example.com please')).toBe(
      'contact me at <redacted> please',
    );
  });

  it('strips Unix /Users/<name> paths', () => {
    expect(redactText('reading /Users/alice/projects/alpha/src/index.ts')).toBe(
      'reading <abs-path>/src/index.ts',
    );
  });

  it('strips /home/<name> paths', () => {
    expect(redactText('writing /home/bob/notes.txt')).toBe(
      'writing <abs-path>/notes.txt',
    );
  });

  it('strips Windows C:\\Users\\<name> paths', () => {
    expect(redactText('opening C:\\Users\\carol\\file.txt')).toBe(
      'opening <abs-path>\\file.txt',
    );
  });

  it('leaves a relative path untouched', () => {
    expect(redactText('relative path: src/foo.ts')).toBe('relative path: src/foo.ts');
  });

  it('collapses control characters to spaces', () => {
    const input = 'before\x01\x02\x03after';
    expect(redactText(input)).toBe('before after');
  });

  it('normalises whitespace runs to one space', () => {
    expect(redactText('a   b\n\nc\td')).toBe('a b c d');
  });

  it('length-clips beyond the default 240', () => {
    const long = 'x'.repeat(500);
    const out = redactText(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });

  it('honours a custom max', () => {
    const out = redactText('abcdefghij', 5);
    expect(out).toBe('abcd…');
  });

  it('handles non-string input gracefully', () => {
    expect(redactText(undefined as unknown as string)).toBe('');
    expect(redactText(null as unknown as string)).toBe('');
  });

  it('processes multiple secrets in one string', () => {
    const input = 'Bearer abc123def456ghi789 key=sk-1234567890abcdefghij user@x.com';
    const out = redactText(input);
    expect(out).not.toContain('abc123def456ghi789');
    expect(out).not.toContain('sk-1234');
    expect(out).not.toContain('user@x.com');
  });
});

describe('redactPath', () => {
  it('keeps the last two segments of a Unix path', () => {
    expect(redactPath('/Users/alice/projects/alpha/src/index.ts')).toBe(
      '…/alpha/src/index.ts',
    );
  });

  it('keeps the last two segments of a Windows path', () => {
    expect(redactPath('C:\\Users\\carol\\projects\\beta\\README.md')).toBe(
      '…/projects/beta/README.md',
    );
  });

  it('passes through short relative paths', () => {
    expect(redactPath('src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns empty string for empty input', () => {
    expect(redactPath('')).toBe('');
  });
});

describe('redactEnv', () => {
  it('preserves whitelisted keys with truncated values', () => {
    const out = redactEnv({
      NODE_ENV: 'production',
      LANG: 'en_US.UTF-8',
      SECRET_API_KEY: 'sk-1234567890abcdefghij',
    });
    expect(out.NODE_ENV).toBe('production');
    expect(out.LANG).toBe('en_US.UTF-8');
    expect(out.SECRET_API_KEY ?? '').toBe('<env>');
  });

  it('always preserves the key names', () => {
    const out = redactEnv({ TRYLO_TOKEN: 'whatever' });
    expect(Object.keys(out)).toEqual(['TRYLO_TOKEN']);
  });

  it('returns empty for non-object input', () => {
    expect(redactEnv(undefined as unknown as Record<string, string>)).toEqual({});
    expect(redactEnv(null as unknown as Record<string, string>)).toEqual({});
  });

  it('truncates long whitelisted values to 64 chars', () => {
    const long = 'a'.repeat(200);
    const out = redactEnv({ NODE_ENV: long });
    expect(out.NODE_ENV ?? '').toHaveLength(64);
  });
});

describe('fnv1a32 / anonId', () => {
  it('produces a deterministic 8-char hex for the same input', () => {
    const a = fnv1a32('hello world');
    const b = fnv1a32('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces different hashes for different inputs', () => {
    const a = fnv1a32('alpha');
    const b = fnv1a32('beta');
    expect(a).not.toBe(b);
  });

  it('returns the empty-hash sentinel for empty input', () => {
    expect(fnv1a32('')).toBe('00000000');
  });

  it('anonId truncates to the requested width', () => {
    expect(anonId('hello', 12)).toHaveLength(12);
    expect(anonId('hello', 4)).toHaveLength(4);
  });

  it('anonId clamps to [4, 32]', () => {
    expect(anonId('x', 0).length).toBeGreaterThanOrEqual(4);
    expect(anonId('x', 9999).length).toBeLessThanOrEqual(32);
  });
});
