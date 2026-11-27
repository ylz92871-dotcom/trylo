import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { createWorkspacePagePreview } from '../../src/tooling/browser/workspace-page-preview.mjs';

async function temporaryRoot(t) {
  const scratch = temporaryPath('workspace-page-preview-tests');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'page-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('approved workspace pages and static assets use a separate loopback origin', async t => {
  const root = await temporaryRoot(t);
  await fs.writeFile(path.join(root, 'index.html'), '<script src="app.js"></script>');
  await fs.writeFile(path.join(root, 'app.js'), 'document.body.dataset.ok="yes"');
  await fs.writeFile(path.join(root, '.secret.html'), 'private');
  await fs.writeFile(path.join(root, 'secret.txt'), 'private');
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  const url = await preview.open(pathToFileURL(path.join(root, 'index.html')).href);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(await (await fetch(url)).text(), '<script src="app.js"></script>');
  assert.equal(await (await fetch(new URL('app.js', url))).text(), 'document.body.dataset.ok="yes"');
  assert.equal((await fetch(new URL('.secret.html', url))).status, 403);
  assert.equal((await fetch(new URL('secret.txt', url))).status, 403);
  assert.equal((await fetch(new URL('/index.html', url))).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  await assert.rejects(preview.open(pathToFileURL(path.join(root, '..', 'outside.html')).href));
  await assert.rejects(preview.open('file://remote-host/share/index.html'));
  await assert.rejects(preview.open('file://localhost/share/index.html'));
  await assert.rejects(preview.open('file:////remote-host/share/index.html'));
  await assert.rejects(preview.open('javascript:alert(1)'));
});
test('a symlink cannot expose files outside the approved workspace', async t => {
  const outer = await temporaryRoot(t);
  const root = path.join(outer, 'workspace'), outside = path.join(outer, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'index.html'), 'private');
  await fs.writeFile(path.join(root, 'index.html'), '<html>preview</html>');
  await fs.writeFile(path.join(outside, 'model.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 0xff]));
  await fs.symlink(outside, path.join(root, 'linked'), 'junction');
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  await assert.rejects(preview.open(pathToFileURL(path.join(root, 'linked', 'index.html')).href));
  const url = await preview.open(pathToFileURL(path.join(root, 'index.html')).href);
  assert.equal((await fetch(new URL('linked/model.glb', url))).status, 403);
});

const assets = [
  ['mesh.glb', 'model/gltf-binary', Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 0xff, 0x80])],
  ['mesh.gltf', 'model/gltf+json; charset=utf-8', Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin","byteLength":4}]}')],
  ['mesh.bin', 'application/octet-stream', Buffer.from([0, 0xff, 0x80, 0x0a])],
  ['mesh.obj', 'model/obj', Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')],
  ['mesh.stl', 'model/stl', Buffer.from([0, 0xff, 0x80, 0x0a, 0])],
  ['mesh.3mf', 'model/3mf', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80])],
];

for (const [name, contentType, bytes] of assets) {
  test(`${name} is served with its model MIME type and original bytes`, async t => {
    const root = await temporaryRoot(t);
    await fs.writeFile(path.join(root, 'index.html'), '<html>3D preview</html>');
    await fs.mkdir(path.join(root, 'assets'));
    await fs.writeFile(path.join(root, 'assets', name), bytes);
    const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
    const page = await preview.open(pathToFileURL(path.join(root, 'index.html')).href);
    const url = new URL(`assets/${name}`, page);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), contentType);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(new URL(`/assets/${name}`, page))).status, 404, 'a file extension never replaces the preview token');
  });
}

test('existing binary assets have no text charset and retain their bytes', async t => {
  const root = await temporaryRoot(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80]);
  await fs.writeFile(path.join(root, 'index.html'), '<html>preview</html>');
  await fs.writeFile(path.join(root, 'texture.png'), bytes);
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  const page = await preview.open(pathToFileURL(path.join(root, 'index.html')).href);
  const response = await fetch(new URL('texture.png', page));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('model support does not expose hidden data, generic JSON or arbitrary files', async t => {
  const root = await temporaryRoot(t);
  await fs.writeFile(path.join(root, 'index.html'), '<html>preview</html>');
  await fs.mkdir(path.join(root, '.trylo'));
  await fs.writeFile(path.join(root, '.trylo', 'model.gltf'), '{"private":true}');
  await fs.writeFile(path.join(root, '.private.glb'), 'private');
  await fs.writeFile(path.join(root, 'credentials.json'), '{"private":true}');
  await fs.writeFile(path.join(root, 'private.txt'), 'private');
  await fs.writeFile(path.join(root, 'arbitrary.exe'), 'private');
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  const page = await preview.open(pathToFileURL(path.join(root, 'index.html')).href);
  for (const name of ['.trylo/model.gltf', '.private.glb', 'credentials.json', 'private.txt', 'arbitrary.exe']) {
    assert.equal((await fetch(new URL(name, page))).status, 403, name);
  }
});

test('product HTML output and its assets are previewable while private workspace state stays closed', async t => {
  const root = await temporaryRoot(t);
  const output = path.join(root, '.trylo', 'out', '电机 课程');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'index.html'), '<script src="app.js"></script>');
  await fs.writeFile(path.join(output, 'app.js'), 'document.title="课程"');
  await fs.writeFile(path.join(output, '.private.html'), 'private');
  await fs.mkdir(path.join(output, '.cache')); await fs.writeFile(path.join(output, '.cache', 'data.js'), 'private');
  await fs.mkdir(path.join(root, '.trylo', 'sessions')); await fs.writeFile(path.join(root, '.trylo', 'sessions', 'index.html'), 'private');
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  const file = pathToFileURL(path.join(output, 'index.html')); file.search = '?mode=lesson'; file.hash = '#rotor';
  const page = await preview.open(file.href);
  assert.equal(new URL(page).search, '?mode=lesson'); assert.equal(new URL(page).hash, '#rotor');
  assert.equal(await (await fetch(page)).text(), '<script src="app.js"></script>');
  assert.equal(await (await fetch(new URL('app.js', page))).text(), 'document.title="课程"');
  for (const relative of ['.private.html', '.cache/data.js', '../../sessions/index.html']) {
    assert.equal((await fetch(new URL(relative, page))).status, 403, relative);
  }
  await assert.rejects(preview.open(pathToFileURL(path.join(root, '.trylo', 'sessions', 'index.html')).href));
  await assert.rejects(preview.open(pathToFileURL(path.join(output, '.private.html')).href));
});

test('product output links cannot publish outside files or private session state', async t => {
  const outer = await temporaryRoot(t), root = path.join(outer, 'workspace');
  const output = path.join(root, '.trylo', 'out', 'lesson'), privateState = path.join(root, '.trylo', 'sessions');
  const outside = path.join(outer, 'outside');
  for (const directory of [output, privateState, outside]) await fs.mkdir(directory, { recursive: true });
  for (const directory of [privateState, outside]) {
    await fs.writeFile(path.join(directory, 'index.html'), 'private');
    await fs.writeFile(path.join(directory, 'data.js'), 'private');
  }
  await fs.writeFile(path.join(output, 'index.html'), '<html>lesson</html>');
  await fs.symlink(privateState, path.join(output, 'private-link'), 'junction');
  await fs.symlink(outside, path.join(output, 'outside-link'), 'junction');
  const preview = createWorkspacePagePreview(root); t.after(() => preview.dispose());
  const page = await preview.open(pathToFileURL(path.join(output, 'index.html')).href);
  for (const link of ['private-link', 'outside-link']) {
    await assert.rejects(preview.open(pathToFileURL(path.join(output, link, 'index.html')).href));
    assert.equal((await fetch(new URL(`${link}/data.js`, page))).status, 403, link);
  }
});
