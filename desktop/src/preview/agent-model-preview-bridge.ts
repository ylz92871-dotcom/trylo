import type { ModelPreviewController, ModelPreviewState } from '../components/preview/ModelPreview';
import type { AgentModelPreviewChanged, AgentModelPreviewCommand } from './agent-model-preview-types';

export interface AgentModelSession {
  readonly key: number;
  readonly scope: string;
  readonly projectRoot: string;
  readonly workspaceRoot?: string;
  readonly conversationId: string;
  readonly path: string;
  revision: string | number;
  fileSignature?: string;
  autoRefresh: boolean;
}
interface Binding {
  readonly session: AgentModelSession;
  controller?: ModelPreviewController;
  state?: ModelPreviewState;
  waiters: Set<{ revision: string | number; resolve: (state: ModelPreviewState) => void; reject: (error: Error) => void }>;
}

/** One lifetime owner for scene instances, readiness and original-scope replies. */
export class AgentModelPreviewBridge {
  private readonly scenes = new Map<string, Binding>();
  private readonly listeners = new Set<() => void>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, AbortController>();
  private serial = 0;
  private disposed = false;

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  sessions(): readonly AgentModelSession[] { return [...this.scenes.values()].map(binding => ({ ...binding.session })); }
  private publish(): void { for (const listener of this.listeners) listener(); }
  private reject(binding: Binding, reason: string): void {
    for (const waiter of binding.waiters) waiter.reject(new Error(reason));
    binding.waiters.clear();
  }

  bind(scope: string, key: number, controller: ModelPreviewController | null): void {
    const binding = this.scenes.get(scope);
    if (!binding || binding.session.key !== key) return;
    binding.controller = controller ?? undefined;
    if (controller) this.observe(scope, key, controller.getState());
  }

  observe(scope: string, key: number, state: ModelPreviewState): void {
    const binding = this.scenes.get(scope);
    if (!binding || binding.session.key !== key) return;
    binding.state = state;
    for (const waiter of binding.waiters) {
      if (state.revision !== waiter.revision || state.status === 'loading') continue;
      binding.waiters.delete(waiter);
      if (state.status === 'error') waiter.reject(new Error(state.message || '模型无法加载'));
      else waiter.resolve(state);
    }
  }

  private ready(binding: Binding, signal: AbortSignal): Promise<ModelPreviewState> {
    signal.throwIfAborted();
    const state = binding.state;
    if (state?.revision === binding.session.revision) {
      if (state.status === 'ready' && binding.controller) return Promise.resolve(state);
      if (state.status === 'error') return Promise.reject(new Error(state.message || '模型无法加载'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', cancelled);
      const waiter = { revision: binding.session.revision,
        resolve: (value: ModelPreviewState): void => { cleanup(); resolve(value); },
        reject: (error: Error): void => { cleanup(); reject(error); } };
      const cancelled = (): void => { binding.waiters.delete(waiter); waiter.reject(new Error('3D 预览请求已取消')); };
      binding.waiters.add(waiter);
      signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  changed(event: AgentModelPreviewChanged): void {
    const binding = this.scenes.get(event.scope);
    if (!binding || binding.session.path !== event.path || binding.session.projectRoot !== event.projectRoot
      || binding.session.conversationId !== event.conversationId || binding.session.revision === event.revision) return;
    this.reject(binding, '模型文件已更新，请查看新版本');
    binding.session.revision = event.revision;
    binding.session.fileSignature = event.fileSignature ?? binding.session.fileSignature;
    if (event.error) binding.session.autoRefresh = false;
    this.publish();
  }

  close(scope: string): void {
    const binding = this.scenes.get(scope);
    if (!binding) return;
    this.reject(binding, '3D 预览已关闭');
    this.scenes.delete(scope);
    this.publish();
  }

  execute(command: AgentModelPreviewCommand): Promise<Readonly<Record<string, unknown>>> {
    const abort = new AbortController();
    this.pending.set(command.id, abort);
    const previous = this.queues.get(command.scope) ?? Promise.resolve();
    const task = command.operation === 'close' ? this.run(command, abort.signal)
      : previous.catch(() => {}).then(() => this.run(command, abort.signal));
    this.queues.set(command.scope, task);
    void task.finally(() => {
      this.pending.delete(command.id);
      if (this.queues.get(command.scope) === task) this.queues.delete(command.scope);
    }).catch(() => {});
    return task;
  }

  cancel(id: string): void { this.pending.get(id)?.abort(); }

  cancelAll(): void {
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
    this.queues.clear();
  }

  private async run(command: AgentModelPreviewCommand, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('3D 预览窗口已断开');
    if (command.operation === 'close') { this.close(command.scope); return { closed: true }; }
    let binding = this.scenes.get(command.scope);
    if (command.operation === 'open') {
      if (!command.path || command.revision === undefined) throw new Error('模型预览缺少文件版本');
      if (!binding || binding.session.path !== command.path || binding.session.projectRoot !== command.projectRoot) {
        if (binding) this.reject(binding, '已打开另一份模型');
        binding = { session: { key: ++this.serial, scope: command.scope, projectRoot: command.projectRoot, workspaceRoot: command.workspaceRoot,
          conversationId: command.conversationId, path: command.path, revision: command.revision, fileSignature: command.fileSignature, autoRefresh: command.autoRefresh === true }, waiters: new Set() };
        this.scenes.set(command.scope, binding);
        this.publish();
      } else if (binding.session.revision !== command.revision) {
        binding.session.autoRefresh = command.autoRefresh === true;
        this.changed({ ...binding.session, bridgeId: command.bridgeId, revision: command.revision, fileSignature: command.fileSignature });
      }
    }
    if (!binding || binding.session.projectRoot !== command.projectRoot || binding.session.conversationId !== command.conversationId) {
      throw new Error('请先为此聊天打开一个 3D 模型');
    }
    await this.ready(binding, signal);
    signal.throwIfAborted();
    const controller = binding.controller;
    if (!controller || this.scenes.get(command.scope) !== binding) throw new Error('模型预览已更换');
    if (command.operation === 'view') {
      if (command.preset) controller.setCamera(command.preset);
      if (command.position && command.target) controller.setCamera({ position: command.position, target: command.target });
      if (command.fit) controller.setCamera('fit');
      if (command.wireframe !== undefined) controller.setWireframe(command.wireframe);
    }
    const result = command.operation === 'snapshot' ? await this.capture(controller, signal) : controller.getState();
    signal.throwIfAborted();
    if (this.scenes.get(command.scope) !== binding || result.revision !== binding.session.revision
      || ('status' in result && result.status !== 'ready')) {
      throw new Error('模型已更新，旧画面不能作为新版本返回');
    }
    return { ...result };
  }

  private capture(controller: ModelPreviewController, signal: AbortSignal): ReturnType<ModelPreviewController['capture']> {
    return new Promise((resolve, reject) => {
      const cancelled = (): void => reject(new Error('3D 预览请求已取消'));
      signal.addEventListener('abort', cancelled, { once: true });
      void controller.capture().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
      if (signal.aborted) cancelled();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    for (const binding of this.scenes.values()) this.reject(binding, '3D 预览窗口已断开');
    this.scenes.clear(); this.listeners.clear();
  }
}
