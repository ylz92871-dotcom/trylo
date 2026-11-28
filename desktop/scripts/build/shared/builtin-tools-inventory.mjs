import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function inventoryTree(root, { excludeInventory = true } = {}) {
  const files = {};
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`Bundle contains a link: ${file}`);
      if (item.isDirectory()) await visit(file);
      else if (!excludeInventory || item.name !== 'inventory.json') files[path.relative(root, file).replaceAll('\\', '/')] = sha(await fs.readFile(file));
    }
  }
  await visit(root);
  return files;
}

export async function writeBuiltinInventory(target, tools) {
  await fs.writeFile(path.join(target, 'tool-sources.json'), JSON.stringify({ schemaVersion: 1, tools }, null, 2) + '\n');
  const inventory = await inventoryTree(target);
  await fs.writeFile(path.join(target, 'inventory.json'), JSON.stringify({ schemaVersion: 1, files: inventory }, null, 2) + '\n');
  return { tools, files: Object.keys(inventory).length };
}
