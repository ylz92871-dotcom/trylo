import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Stage the local manifest required by tauri-build, without the release/download pipeline. */
export function prepareDevResources(desktopRoot) {
  const source = resolve(desktopRoot, 'distribution.json');
  const resources = resolve(desktopRoot, 'src-tauri/resources');
  const target = resolve(resources, 'distribution.json');
  const bytes = readFileSync(source);
  JSON.parse(bytes.toString('utf8'));
  for (const path of [resolve(desktopRoot, 'src-tauri'), resources, target]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refuse to stage dev resources through a redirected path: ${path}`);
    }
  }
  mkdirSync(resources, { recursive: true });
  if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
    writeFileSync(target, bytes);
  }
  // Native dev already resolves this entry from the checkout. Only release
  // packaging requires the separately inventoried compatibility artifact.
  const configPath = resolve(desktopRoot, 'src-tauri/tauri.conf.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const legacyResource = 'resources/cli-legacy/';
  if (config.bundle?.resources?.[legacyResource] && !existsSync(resolve(resources, 'cli-legacy'))) {
    if (!existsSync(resolve(desktopRoot, '../trylo cli/cli.js'))) {
      throw new Error('Desktop dev needs trylo cli/cli.js or a staged resources/cli-legacy runtime.');
    }
    // Tauri uses JSON Merge Patch: null removes this release-only resource.
    return { bundle: { resources: { [legacyResource]: null } } };
  }
  return undefined;
}
