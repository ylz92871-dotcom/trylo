// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('ships a tracked new CLI default for development without private machine configuration', () => {
  expect(readFileSync(new URL('../../.env.development', import.meta.url), 'utf8')).toContain('VITE_TRYLO_NEW_CLI_ONLY=true');
});

it.each(['development', 'production'])('loads the new CLI defaults with actual %s environment precedence', mode => {
  const env = loadEnv(mode, root, 'VITE_');
  expect(env.VITE_TRYLO_DEFAULT_CLI_RUNTIME).toBe('trylo-v1');
  expect(env.VITE_TRYLO_NEW_CLI_ONLY).toBe('true');
  if (mode === 'development') expect(env.VITE_TRYLO_CLI_RUNTIME_PROTOCOL).not.toBe('legacy-stream-json');
});
