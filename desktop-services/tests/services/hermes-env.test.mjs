// hermes-env.mjs 的路径推导与降级语义（spec §7.2 / vendor PATCHES.md）。
// 纯 Node，不 spawn Python。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  STORAGE_SUBDIR,
  storageRoot,
  capabilitiesDir,
  serverScriptPath,
  configureHermesEnv,
} from '../../src/learning/hermes-env.mjs';

const ENV_KEYS = [
  'TRYLO_APP_DATA_DIR',
  'TRYLO_SIDECARS_DIR',
  'TRYLO_HERMES_CAPABILITIES_DIR',
  'TRYLO_HERMES_SERVER_SCRIPT',
];
const SAVED = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tmpDir(name) {
  return mkdtempSync(path.join(tmpdir(), `hermes-env-${name}-`));
}

test('storageRoot: <app-data>/Trylo', () => {
  assert.equal(storageRoot('/data/app'), path.join('/data/app', 'Trylo'));
  assert.equal(STORAGE_SUBDIR, 'Trylo');
});

test('capabilitiesDir: <sidecars>/hermes-capabilities', () => {
  assert.equal(capabilitiesDir('/res/sidecars'), path.join('/res/sidecars', 'hermes-capabilities'));
});

test('serverScriptPath: capabilities + server.py', () => {
  assert.equal(
    serverScriptPath(path.join('/res', 'sidecars', 'hermes-capabilities')),
    path.join('/res', 'sidecars', 'hermes-capabilities', 'server.py'),
  );
  assert.equal(serverScriptPath(''), '');
});

test('configureHermesEnv publishes both env vars for the vendored modules', () => {
  const appData = tmpDir('app');
  const sidecars = tmpDir('side');
  const env = configureHermesEnv({ appDataDir: appData, sidecarsDir: sidecars });

  assert.equal(env.storageRoot, path.join(appData, 'Trylo'));
  assert.equal(env.capabilitiesDir, path.join(sidecars, 'hermes-capabilities'));
  assert.equal(env.serverScript, path.join(sidecars, 'hermes-capabilities', 'server.py'));
  assert.equal(env.configured, true);

  // Vendored modules resolve their Python paths at load time, so the env must
  // already be published when they are required (vendor/PATCHES.md patches 1–6).
  assert.equal(process.env.TRYLO_HERMES_CAPABILITIES_DIR, env.capabilitiesDir);
  assert.equal(process.env.TRYLO_HERMES_SERVER_SCRIPT, env.serverScript);
});

test('configureHermesEnv is idempotent', () => {
  const appData = tmpDir('app2');
  const sidecars = tmpDir('side2');
  const first = configureHermesEnv({ appDataDir: appData, sidecarsDir: sidecars });
  const second = configureHermesEnv({ appDataDir: appData, sidecarsDir: sidecars });
  assert.deepEqual(first, second);
});

test('configureHermesEnv degrades when the shell gave no directories', () => {
  const env = configureHermesEnv({ appDataDir: '', sidecarsDir: '' });
  assert.equal(env.storageRoot, '');
  assert.equal(env.capabilitiesDir, '');
  assert.equal(env.serverScript, '');
  assert.equal(env.configured, false);
  // 未配置时不覆盖已有 env（避免误伤手工调试设置）。
  assert.equal(process.env.TRYLO_HERMES_CAPABILITIES_DIR, SAVED.get('TRYLO_HERMES_CAPABILITIES_DIR'));
});
