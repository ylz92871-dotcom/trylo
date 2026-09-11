// Trylo Desktop — JS wrapper for the test_connection Tauri
// command. The Rust side does a raw TCP + HTTP HEAD probe
// (no reqwest, no new deps). We call it from the Settings
// modal's "Test" button.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-detect';

export interface TestConnectionArgs {
  readonly apiHost: string;
  readonly apiKey: string;
  readonly apiFormat?: 'anthropic' | 'openai';
}

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly provider: string;
  readonly keyStatus: string;
  readonly message: string;
  readonly endpoint: string;
}

export async function testConnection(
  args: TestConnectionArgs,
): Promise<TestConnectionResult> {
  if (!isTauri()) {
    // In plain browser dev, fall back to a fetch probe.
    // CORS will block, but the error itself is informative.
    try {
      const res = await fetch(args.apiHost, { method: 'GET', mode: 'no-cors' });
      return {
        ok: res.type === 'opaque' || res.ok,
        provider: args.apiFormat ?? 'unknown',
        keyStatus: args.apiKey ? 'key present' : 'no key set',
        message: `Browser fetch: ${res.type} (status opaque in no-cors mode)`,
        endpoint: args.apiHost,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        provider: args.apiFormat ?? 'unknown',
        keyStatus: args.apiKey ? 'key present' : 'no key set',
        message: `Browser fetch failed: ${msg}`,
        endpoint: args.apiHost,
      };
    }
  }
  return invoke<TestConnectionResult>('test_connection', {
    args: {
      api_host: args.apiHost,
      api_key: args.apiKey || null,
      api_format: args.apiFormat ?? 'anthropic',
    },
  });
}
