import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const coreProjects = ['desktop', 'new trylo cli', 'desktop-services', 'remote-relay', 'mobile-app', 'trylocode-site'];
const rootDirectories = new Set([...coreProjects, 'docs', 'scripts', '_workspace', '.git', '.trylo', '.github']);
const rootFiles = new Set(['AGENTS.md', 'README.md', 'README.en.md', 'README.zh-CN.md', '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', 'LICENSE', 'LICENSE.md', 'NOTICE']);
const commonDirectories = ['src', 'tests', 'test', 'testdata', 'docs', 'scripts', 'licenses', 'vendor', 'node_modules', 'dist', '.trylo'];
const projectDirectories = {
  desktop: ['compat', 'public', 'sidecars', 'src-tauri', 'vite-plugins'],
  'new trylo cli': ['.agents', 'vendor-bin'],
  'desktop-services': ['toolchain'],
  'remote-relay': ['deploy'],
  'mobile-app': ['android', 'preview'],
  'trylocode-site': ['app', 'assets', 'chat', 'console', 'remote', 'yl', 'design', 'prototypes'],
};
const commonFiles = /^(?:AGENTS\.md|README(?:[-.][\w-]+)?\.(?:md|txt)|CHANGELOG\.md|LICENSE(?:\.md|\.txt)?|NOTICE(?:\.txt)?|PROVENANCE\.md|package(?:-lock)?\.json|pnpm-(?:lock\.yaml|workspace\.yaml)|tsconfig(?:\.[\w-]+)?\.json|tsconfig\.tsbuildinfo|vite\.config\.ts|vitest\.config\.[cm]?[jt]s|index\.html|\.gitignore|\.gitattributes|\.env(?:\.[\w.-]+)?|\.eslintrc\.json|\.prettierrc\.json)$/;
const projectFiles = {
  desktop: ['distribution.json', 'computer-preview.html'],
  'remote-relay': ['ACCOUNT-SERVICE.md', 'SCHEDULED-SECURITY-BACKUP.md', 'SECURITY-BACKUP.md', 'SECURITY-DEFENSE-ACCEPTANCE.md', 'SECURITY.md', 'TRANSPORT-DEFENSE.md'],
  'mobile-app': ['capacitor.config.ts'],
  'trylocode-site': ['_headers', '_redirects', 'DEPLOY.md', 'deploy.mjs', 'desktop-release.json', 'REDESIGN-PLAN.md'],
};

/** Inspect only repository/project boundaries; never traverse dependencies or private runtime data. */
export function inspectWorkspaceLayout(root, pendingMoves = []) {
  const violations = [];
  const pending = [];
  const exceptions = new Map();
  for (const item of pendingMoves) {
    const normalized = item.path?.replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.' || !part) || !item.reason || !item.evidence) {
      throw new Error('Every pending move needs an exact repository-relative path, reason and evidence.');
    }
    if (exceptions.has(normalized)) throw new Error(`Duplicate pending move: ${normalized}`);
    exceptions.set(normalized, item);
  }
  const hasPendingBelow = relative => [...exceptions.keys()].some(item => item.startsWith(`${relative}/`));
  function inspectEntry(relative, allowed) {
    const absolute = path.join(root, ...relative.split('/'));
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      violations.push({ path: relative, reason: 'Core/project boundaries must not be hidden compatibility links.' });
      return;
    }
    const exception = exceptions.get(relative);
    if (exception) { pending.push(exception); return; }
    if (allowed(info)) return;
    if (info.isDirectory() && hasPendingBelow(relative)) {
      for (const child of readdirSync(absolute)) inspectEntry(`${relative}/${child}`, () => false);
      return;
    }
    violations.push({ path: relative, reason: 'Unregistered file or development byproduct: choose its owning project or _workspace category.' });
  }
  for (const entry of readdirSync(root)) {
    // A linked Git worktree has a .git file, not a directory.
    inspectEntry(entry, info => entry === '.git' || (info.isDirectory() ? rootDirectories.has(entry) : rootFiles.has(entry)));
  }
  for (const project of coreProjects) {
    const absolute = path.join(root, project);
    if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) continue;
    const directories = new Set([...commonDirectories, ...projectDirectories[project]]);
    const files = new Set(projectFiles[project] ?? []);
    for (const name of readdirSync(absolute)) {
      inspectEntry(`${project}/${name}`, info => info.isDirectory() ? directories.has(name) : commonFiles.test(name) || files.has(name));
    }
  }
  for (const [relative, item] of exceptions) {
    if (!pending.includes(item)) violations.push({ path: relative, reason: 'Pending move is absent or outside inspected boundaries; review and remove stale debt explicitly.' });
  }
  return { violations, pending, clean: violations.length === 0 && pending.length === 0 };
}
