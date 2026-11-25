import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const bundleResources = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).bundle.resources;

function rejectRedirectedPath(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refuse to stage dev resources through a redirected path: ${path}`);
  }
}

/** Stage the local manifest required by tauri-build, without the release/download pipeline. */
export function prepareDevResources(desktopRoot) {
  const source = resolve(desktopRoot, 'distribution.json');
  const resources = resolve(desktopRoot, 'src-tauri/resources');
  const target = resolve(resources, 'distribution.json');
  const bytes = readFileSync(source);
  JSON.parse(bytes.toString('utf8'));
  for (const path of [resolve(desktopRoot, 'src-tauri'), resources, target]) {
    rejectRedirectedPath(path);
  }
  mkdirSync(resources, { recursive: true });

  // Tauri validates every bundle resource even in dev. Give its directory
  // mappings an empty source on a fresh checkout and retain staged files.
  for (const source of Object.keys(bundleResources)) {
    if (!source.startsWith('resources/') || !source.endsWith('/')) continue;
    let directory = resources;
    for (const part of source.slice('resources/'.length, -1).split('/')) {
      directory = join(directory, part);
      rejectRedirectedPath(directory);
      mkdirSync(directory, { recursive: true });
    }
  }
  if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
    writeFileSync(target, bytes);
  }
  return undefined;
}
