import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { desktopRoot, repositoryRoot } from './build/shared/paths.mjs';
import { buildPlatform } from './build/shared/platform.mjs';

test('build roots are independent of the caller working directory', () => {
  assert.ok(existsSync(path.join(desktopRoot, 'src-tauri/tauri.conf.json')));
  assert.ok(existsSync(path.join(repositoryRoot, 'desktop-services/package.json')));
});

test('platform configuration preserves the Windows package and excludes its pet from common resources', () => {
  const read = name => JSON.parse(readFileSync(path.join(desktopRoot, 'src-tauri', name), 'utf8'));
  const common = read('tauri.conf.json');
  const windows = read(buildPlatform('win32').config);
  assert.deepEqual(windows.bundle.targets, ['nsis']);
  assert.equal(common.bundle.resources['resources/sidecars/desktop-companion/publish/'], undefined);
  assert.equal(windows.bundle.resources['resources/sidecars/desktop-companion/publish/'], 'sidecars/desktop-companion/publish/');
  assert.deepEqual(read(buildPlatform('darwin').config).bundle.targets, ['app', 'dmg']);
  assert.deepEqual(read(buildPlatform('linux').config).bundle.targets, ['deb']);
  assert.throws(() => buildPlatform('unknown'), /unsupported/);
});
