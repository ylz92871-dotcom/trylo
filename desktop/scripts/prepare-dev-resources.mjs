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
  return undefined;
}
