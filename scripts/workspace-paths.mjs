import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository maintenance/build output paths; never a product user's runtime root. */
export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const workspaceRoot = path.join(repositoryRoot, '_workspace');

export function workspacePath(...segments) {
  const destination = path.resolve(workspaceRoot, ...segments);
  const relative = path.relative(workspaceRoot, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Development output must stay inside the repository _workspace directory.');
  }
  return destination;
}

export const artifactPath = (...segments) => workspacePath('artifacts', ...segments);
export const taskPath = (...segments) => workspacePath('tasks', ...segments);
export const operationsPath = (...segments) => workspacePath('operations', ...segments);
export const temporaryPath = (...segments) => workspacePath('tmp', ...segments);
