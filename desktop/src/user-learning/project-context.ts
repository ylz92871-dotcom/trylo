import { newId, sourceHash } from './ids';
import type { ProductSurface, ProjectContextSnapshot } from './types';

export function buildProjectContext(input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly product: ProductSurface;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly gitDirty?: boolean;
  readonly gitBranch?: string;
  readonly hasTests?: boolean;
  readonly now?: number;
}): ProjectContextSnapshot {
  const now = input.now ?? Date.now();
  const languages = input.languages ?? [];
  const hash = sourceHash([
    input.projectId,
    input.workspaceId,
    languages.join(','),
    String(input.gitDirty ?? false),
    input.gitBranch ?? '',
    String(input.hasTests ?? false),
  ]);
  return {
    id: newId('pctx', now),
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    product: input.product,
    languages,
    frameworks: input.frameworks ?? [],
    components: [],
    criticalPaths: ['runtime', 'persistence', 'auth'],
    git: {
      branch: input.gitBranch,
      dirty: input.gitDirty === true,
      rollbackAvailable: true,
    },
    verification: {
      typecheck: languages.some((l) => /ts|js|py|rs|go/i.test(l)),
      unit: input.hasTests === true,
      integration: false,
      e2e: false,
      smoke: false,
    },
    risk: {
      persistentStateComponents: ['memory', 'session', 'database'],
      securitySensitiveAreas: ['auth', 'permissions', 'secrets'],
      dataIntegrityAreas: ['migrations', 'store', 'schema'],
    },
    reversibility: 'medium',
    hash,
    discoveredFrom: ['heuristic'],
    createdAt: now,
  };
}

export function inferLanguagesFromRoot(root: string): readonly string[] {
  if (/trylo/i.test(root)) return ['typescript', 'javascript', 'rust'];
  return [];
}

export interface ProjectDiscovery {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly hasTests: boolean;
  readonly gitDirty: boolean;
  readonly gitBranch?: string;
  readonly names: readonly string[];
}

export async function discoverProjectFacts(
  root: string,
  deps: {
    readonly listDir?: (path: string) => Promise<readonly { name: string; isDirectory: boolean }[]>;
    readonly gitSnapshot?: () => Promise<{
      repository: boolean;
      head?: string;
      entries: readonly { path: string }[];
    }>;
  } = {},
): Promise<ProjectDiscovery> {
  let names: string[] = [];
  try {
    const entries = await deps.listDir?.(root);
    names = (entries ?? []).map((e) => e.name.toLowerCase());
  } catch {
    names = [];
  }
  const languages: string[] = [];
  if (names.includes('tsconfig.json') || names.includes('package.json')) languages.push('typescript', 'javascript');
  if (names.includes('cargo.toml')) languages.push('rust');
  if (names.includes('go.mod')) languages.push('go');
  if (names.includes('pyproject.toml') || names.includes('requirements.txt')) languages.push('python');
  const frameworks: string[] = [];
  if (names.includes('vite.config.ts') || names.includes('vite.config.js')) frameworks.push('vite');
  if (names.some((n) => n.includes('tauri'))) frameworks.push('tauri');
  let gitDirty = false;
  let gitBranch: string | undefined;
  let gitTestHit = false;
  try {
    const git = await deps.gitSnapshot?.();
    if (git?.repository) {
      gitDirty = git.entries.length > 0;
      gitBranch = git.head;
      gitTestHit = git.entries.some((e) => /\.(test|spec)\.|e2e|__tests__/i.test(e.path));
    }
  } catch {
    // discovery never blocks the agent
  }
  const hasTests = gitTestHit
    || names.some((n) => /test|spec|e2e/.test(n));
  return {
    languages: languages.length ? [...new Set(languages)] : inferLanguagesFromRoot(root),
    frameworks,
    hasTests,
    gitDirty,
    gitBranch,
    names,
  };
}
