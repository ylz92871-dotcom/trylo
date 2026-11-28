import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inventoryTree } from '../shared/builtin-tools-inventory.mjs';

export const macosNodePin = Object.freeze({
  version: 'v24.14.1',
  triple: 'darwin-arm64',
  archiveSha256: '25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe',
  nodeSha256: '35d4bc736bbe4161f0c074aa140ddb74586e46969bc2ad63d32c838bec4463ff',
  licenseSha256: '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18',
  npmTreeSha256: '2889220d68406e8f618bb3badb44eae05bcaa5ba24aae0a0e5b086376e074ff8',
});

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyMacosNode(root) {
  assert.equal(await fs.realpath(root), root, 'Pinned Node runtime directory is redirected');
  for (const [relative, pin] of [['bin/node', macosNodePin.nodeSha256], ['NODE-LICENSE.txt', macosNodePin.licenseSha256]]) {
    const file = path.join(root, relative);
    assert.equal(await fs.realpath(file), file, `Pinned Node file is redirected: ${relative}`);
    assert.equal(sha256(await fs.readFile(file)), pin, `Pinned Node file differs: ${relative}`);
  }
  const npm = path.join(root, 'lib/node_modules/npm');
  assert.equal(await fs.realpath(npm), npm, 'Pinned npm directory is redirected');
  const files = Object.entries(await inventoryTree(npm, { excludeInventory: false }))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(sha256(JSON.stringify(files)), macosNodePin.npmTreeSha256, 'Pinned npm runtime closure differs');
}
