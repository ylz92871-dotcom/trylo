import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopReleasePolicy } from './desktop-release-policy.mjs';

const release = { version: '1.1.0', installer: { file: 'Trylo_1.1.0_x64-setup.exe', path: '/download/desktop/releases/1.1.0/Trylo_1.1.0_x64-setup.exe' } };
test('preserves old installer headers and unrelated policy on a repeat release', () => {
  const old = '    @desktopPackages path /download/desktop/releases/*\n    @desktopInstaller path /download/desktop/releases/1.0.6/Trylo_1.0.6_x64-setup.exe\n    header @desktopInstaller Content-Disposition "attachment; filename=Trylo_1.0.6_x64-setup.exe"\n    header @desktopDelivery X-Trylo-Desktop "1.0.6"\n    header Content-Security-Policy "default-src none"\n    file_server\n';
  const next = desktopReleasePolicy(old, release);
  assert.ok(next.includes('filename=Trylo_1.0.6_x64-setup.exe'));
  assert.ok(next.includes('filename=Trylo_1.1.0_x64-setup.exe'));
  assert.ok(next.includes('header Content-Security-Policy "default-src none"'));
  assert.equal(next.match(/@desktopPackages path/g).length, 1);
  assert.throws(() => desktopReleasePolicy(next, release), /already/);
  assert.equal(desktopReleasePolicy(next, release, { reuseExisting: true }), next);
  assert.throws(() => desktopReleasePolicy(next.replace('application/octet-stream', 'text/plain'), release, { reuseExisting: true }), /differs/);
});
test('refuses an unrelated route and an ambiguous server configuration', () => {
  assert.throws(() => desktopReleasePolicy('    file_server\n', { ...release, installer: { ...release.installer, path: '/account/' } }));
  assert.throws(() => desktopReleasePolicy('    file_server\n    file_server\n', release));
});
