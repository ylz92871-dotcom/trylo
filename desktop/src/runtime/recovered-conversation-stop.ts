import type { LiveProcessInfo, ProcessService } from '../host-adapter/process-service';
import type { CodeRunViewState } from './runtime-types';

type Scope = { readonly projectKey: string; readonly conversationId: string };
type Selection = { readonly kind: 'conversation'; readonly scope: Scope }
  | { readonly kind: 'workspace'; readonly projectKey: string } | { readonly kind: 'all' };
type ProcessPort = Pick<ProcessService, 'list' | 'stop' | 'hasTeamOwner'>;
type Entry = {
  readonly selection: Selection;
  targets: readonly LiveProcessInfo[];
  state: { readonly kind: 'inspecting' | 'stopping'; readonly completion: Promise<void> }
    | { readonly kind: 'failed' | 'detached'; readonly error: Error };
};
const ROOT_LABELS = new Set(['trylo-cli', 'trylo-cli-v1', 'trylo-cli-prewarm']);
const NATIVE_WAIT_MS = 5_000;
const key = (selection: Selection): string => JSON.stringify(selection);
function includes(selection: Selection, scope: Scope): boolean {
  if (selection.kind === 'all') return true;
  if (selection.kind === 'workspace') return selection.projectKey === scope.projectKey;
  return selection.scope.projectKey === scope.projectKey && selection.scope.conversationId === scope.conversationId;
}
function matchesRoot(process: LiveProcessInfo, scope: Scope, excluded: ReadonlySet<string>): boolean {
  return ROOT_LABELS.has(process.label) && !excluded.has(process.id)
    && process.metadata.projectKey === scope.projectKey && process.metadata.conversationId === scope.conversationId;
}
class DetachedConversationError extends Error {}

/** Every child failure is already retained by its conversation owner. */
class RecoveredChildrenStopError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
  }
}

/** Native registrations outlive a rebuilt JS supervisor. This owner retains
 * failed cleanup until an explicit retry confirms the original targets exited. */
export class RecoveredConversationStop {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly processes: () => Promise<ProcessPort>, private readonly changed: () => void,
    private readonly pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 50)),
    private readonly now: () => number = () => performance.now()) {}

  private async nativeCall<T>(operation: () => Promise<T>, timeoutMs = NATIVE_WAIT_MS): Promise<T> {
    // IPC has no cancellation receipt. A timeout releases the waiter only;
    // late replies cannot resume this operation or establish process exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('等待原生进程控制超时，尚未确认旧执行退出，请重试停止。')), timeoutMs);
      })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  isHeld(projectKey: string, conversationId: string): boolean {
    return [...this.entries.values()].some(entry => includes(entry.selection, { projectKey, conversationId }));
  }

  view(projectKey: string, conversationId: string): CodeRunViewState | null {
    const scope = { projectKey, conversationId };
    const entry = this.entries.get(key({ kind: 'conversation', scope }))
      ?? [...this.entries.values()].find(value => includes(value.selection, scope));
    if (!entry) return null;
    const target = entry.targets.find(process => process.metadata.projectKey === projectKey && process.metadata.conversationId === conversationId);
    return { running: true, sendable: false, error: entry.state.kind === 'failed', bindingState: 'busy',
      activeProcessId: target?.id ?? null, pid: target?.pid ?? null, runId: target?.metadata.runId ?? null };
  }

  stop(projectKey: string, conversationId: string, excluded: ReadonlySet<string> = new Set()): Promise<void> {
    const scope = { projectKey, conversationId };
    return this.begin({ kind: 'conversation', scope }, entry => this.execute(scope, entry, excluded));
  }

  assertAvailable(projectKey: string, conversationId: string, excluded: ReadonlySet<string>): Promise<void> {
    const scope = { projectKey, conversationId };
    return this.begin({ kind: 'conversation', scope }, async entry => {
      const processes = await this.nativeCall(() => this.processes());
      entry.targets = (await this.nativeCall(() => processes.list())).filter(process => matchesRoot(process, scope, excluded));
      if (entry.targets.length) throw new DetachedConversationError('旧执行仍在运行，尚未重新连接输出。请先停止旧执行，再开始新的团队任务。');
      await this.assertNoExternalOwner(processes, scope, excluded);
    }, 'inspecting');
  }

  async inspect(projectKey: string, conversationId: string, excluded: ReadonlySet<string>): Promise<'absent' | 'detached'> {
    try {
      await this.assertAvailable(projectKey, conversationId, excluded);
      return 'absent';
    } catch (error) {
      if (error instanceof DetachedConversationError) return 'detached';
      throw error;
    }
  }

  private begin(selection: Selection, operation: (entry: Entry) => Promise<void>, activity: 'inspecting' | 'stopping' = 'stopping'): Promise<void> {
    const scopeKey = key(selection);
    const previous = this.entries.get(scopeKey);
    if (previous?.state.kind === 'inspecting') {
      if (activity === 'inspecting') return previous.state.completion;
      // A read-only inspection does not satisfy a user's subsequent Stop.
      return previous.state.completion.then(() => this.begin(selection, operation), () => this.begin(selection, operation));
    }
    if (previous?.state.kind === 'stopping') return activity === 'inspecting'
      ? previous.state.completion.then(() => this.begin(selection, operation, activity)) : previous.state.completion;
    let resolve!: () => void; let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const entry: Entry = { selection, targets: previous?.targets ?? [], state: { kind: activity, completion } };
    this.entries.set(scopeKey, entry);
    this.changed();
    void operation(entry).then(() => {
      this.entries.delete(scopeKey); this.changed(); resolve();
    }, (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (selection.kind !== 'conversation' && cause instanceof RecoveredChildrenStopError) this.entries.delete(scopeKey);
      else entry.state = { kind: cause instanceof DetachedConversationError ? 'detached' : 'failed', error };
      this.changed(); reject(error);
    });
    return completion;
  }

  stopWorkspace(projectKey: string, excluded: ReadonlySet<string>): Promise<void> {
    return this.begin({ kind: 'workspace', projectKey }, () => this.stopMatching(excluded, projectKey));
  }
  stopAll(excluded: ReadonlySet<string>): Promise<void> {
    return this.begin({ kind: 'all' }, () => this.stopMatching(excluded));
  }

  private async stopMatching(excluded: ReadonlySet<string>, projectKey?: string): Promise<void> {
    const processes = await this.nativeCall(() => this.processes());
    const scopes = new Map<string, Scope>();
    for (const entry of this.entries.values()) {
      if (entry.selection.kind !== 'conversation') continue;
      const scope = entry.selection.scope;
      if (projectKey === undefined || scope.projectKey === projectKey) scopes.set(key(entry.selection), scope);
    }
    for (const process of await this.nativeCall(() => processes.list())) {
      if (!ROOT_LABELS.has(process.label) || excluded.has(process.id)) continue;
      const metadata = process.metadata;
      if (projectKey !== undefined && metadata.projectKey !== projectKey) continue;
      if (!metadata.projectKey || !metadata.conversationId) throw new Error('旧执行缺少工作区或会话归属，尚未确认全部停止。');
      const scope = { projectKey: metadata.projectKey, conversationId: metadata.conversationId };
      scopes.set(key({ kind: 'conversation', scope }), scope);
    }
    const settled = await Promise.allSettled([...scopes.values()].map(scope => this.stop(scope.projectKey, scope.conversationId, excluded)));
    const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new RecoveredChildrenStopError(errors);
  }

  private async execute(scope: Scope, entry: Entry, excluded: ReadonlySet<string>): Promise<void> {
    const processes = await this.nativeCall(() => this.processes());
    entry.targets = (await this.nativeCall(() => processes.list())).filter(process => matchesRoot(process, scope, excluded));
    this.changed();
    if (!entry.targets.length) return this.assertNoExternalOwner(processes, scope, excluded);
    const stopped = await Promise.allSettled(entry.targets.map(target => this.nativeCall(() => processes.stop(target.id))));
    const ids = new Set(entry.targets.map(target => target.id));
    const deadline = this.now() + NATIVE_WAIT_MS;
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      const remaining = (await this.nativeCall(() => processes.list(), Math.max(1, deadline - this.now())))
        .filter(process => ids.has(process.id));
      // Even a refused command can race a natural exit. The native reaper's
      // absence is the independent exit fact; a stop receipt alone is not.
      if (!remaining.length) return this.assertNoExternalOwner(processes, scope, excluded);
      entry.targets = remaining;
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new Error(`尚未确认旧执行退出，请重试停止：${failures.map(result =>
        result.reason instanceof Error ? result.reason.message : String(result.reason)).join('; ')}`);
      if (this.now() >= deadline) break;
      if (attempt < 100) await this.nativeCall(this.pause, deadline - this.now());
    }
    throw new Error('尚未确认旧执行进程退出，请重试停止。');
  }

  private async assertNoExternalOwner(processes: ProcessPort, scope: Scope, excluded: ReadonlySet<string>): Promise<void> {
    if (!processes.hasTeamOwner) return;
    if (excluded.size > 0 && (await this.nativeCall(() => processes.list())).some(process =>
      excluded.has(process.id) && ROOT_LABELS.has(process.label) && process.metadata.projectKey === scope.projectKey
      && process.metadata.conversationId === scope.conversationId)) return;
    const owned = await this.nativeCall(() => processes.hasTeamOwner!(scope.projectKey, scope.conversationId));
    if (typeof owned !== 'boolean') throw new Error('原生团队归属检查失败，未确认空闲。');
    if (owned) throw new DetachedConversationError('此会话仍有原生团队执行占用，可能位于另一个 Trylo 窗口。请到原窗口停止或稍后重试。');
  }
}
