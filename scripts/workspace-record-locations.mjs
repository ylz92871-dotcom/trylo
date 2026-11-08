import fs from 'node:fs';
import path from 'node:path';
import { artifactPath, operationsPath, repositoryRoot, taskPath, workspacePath, workspaceRoot } from './workspace-paths.mjs';

const repository = path.resolve(repositoryRoot);
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Historical records remain byte-for-byte unchanged. Only a reader's active
 * filesystem locator follows the completed, local workspace relocation index. */
export function relocatedRecordPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('A recorded filesystem path is required.');
  const mappings = [
    { source: path.join(repository, 'work/site-security-v2-20261104'), destination: operationsPath('site-security-v2-20261104') },
    { source: path.join(repository, 'work'), destination: taskPath('legacy-work') },
    { source: path.join(repository, 'output'), destination: artifactPath('output') },
    { source: path.join(repository, 'result'), destination: artifactPath('result') },
  ];
  const index = workspacePath('maintenance', 'record-locations.json');
  let recorded;
  try { recorded = JSON.parse(fs.readFileSync(index, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (recorded !== undefined) {
    if (recorded.schemaVersion !== 1 || !Array.isArray(recorded.locations)) throw new Error('Invalid completed relocation index.');
    for (const row of recorded.locations) {
      if (typeof row.source !== 'string' || typeof row.destination !== 'string') throw new Error('Invalid completed relocation row.');
      const source = path.resolve(repository, row.source), destination = path.resolve(repository, row.destination);
      if (source === repository || !within(repository, source) || !within(workspaceRoot, destination)) throw new Error('Relocation index escapes its workspace.');
      mappings.push({ source, destination });
    }
  }
  const candidate = path.resolve(value);
  const selected = mappings.sort((a, b) => b.source.length - a.source.length).find(row => within(row.source, candidate));
  return selected ? path.join(selected.destination, path.relative(selected.source, candidate)) : candidate;
}
