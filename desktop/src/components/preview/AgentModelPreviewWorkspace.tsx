import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import type { ServiceManager } from '../../services-host/service-manager';
import { useAgentModelPreview } from '../../preview/use-agent-model-preview';
import type { AgentModelSession, AgentModelPreviewBridge } from '../../preview/agent-model-preview-bridge';
import type { ModelPreviewController, ModelPreviewState } from './ModelPreview';

const ModelPreview = lazy(() => import('./ModelPreview').then(module => ({ default: module.ModelPreview })));

function Scene({ session, bridge, visible, onClose }: {
  session: AgentModelSession; bridge: AgentModelPreviewBridge; visible: boolean; onClose: () => void;
}): ReactElement {
  const controller = useRef<ModelPreviewController | null>(null);
  const [state, setState] = useState<ModelPreviewState>();
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState('');
  const bind = useCallback((value: ModelPreviewController | null): void => {
    controller.current = value; bridge.bind(session.scope, session.key, value);
  }, [bridge, session.scope, session.key]);
  const observe = useCallback((value: ModelPreviewState): void => {
    setState(value); bridge.observe(session.scope, session.key, value);
  }, [bridge, session.scope, session.key]);
  useEffect(() => {
    if (!expanded || !visible) return;
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [expanded, visible]);
  const name = session.path.replace(/\\/g, '/').split('/').at(-1) ?? session.path;
  const reload = (): void => {
    setActionError('');
    void controller.current?.reload().catch(error => setActionError(String(error.message ?? error)));
  };
  return <section className={`agent-model-scene${visible ? ' agent-model-scene--visible' : ''}${expanded && visible ? ' agent-model-scene--expanded' : ''}`}
    aria-label={`3D 工作区：${name}`} aria-hidden={!visible}
    ref={element => element?.toggleAttribute('inert', !visible)}>
    <header className="file-peek__header agent-model-scene__header">
      <Box size={17} strokeWidth={1.6} aria-hidden="true" />
      <div className="agent-model-scene__identity"><strong title={session.path}>{name}</strong><span>3D 工作区</span></div>
      <button className="file-peek__expand" type="button" aria-label="重新加载模型" title="重新加载模型" onClick={reload}><RotateCw size={15} /></button>
      <button className="file-peek__expand" type="button" aria-label={expanded ? '缩小 3D 工作区' : '放大 3D 工作区'} title={expanded ? '退出全屏' : '放大'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button className="file-peek__close" type="button" aria-label="关闭 3D 工作区" title="关闭 3D 工作区" onClick={onClose}><X size={15} /></button>
    </header>
    <div className="agent-model-scene__status" role="status">
      <span data-state={state?.status ?? 'loading'}>{state?.status === 'ready' ? '已同步' : state?.status === 'error' ? '载入失败' : '正在更新'}</span>
      {state?.readyVersion !== null && state?.readyVersion !== undefined && <span>场景 v{state.readyVersion}</span>}
      <span>{session.autoRefresh ? '文件变化时自动更新' : '可重新加载以同步文件'}</span>
    </div>
    {actionError && <div className="file-peek__meta" role="alert">{actionError}</div>}
    <div className="agent-model-scene__viewport"><Suspense fallback={<div className="preview__empty" role="status">正在打开 3D 场景…</div>}><ModelPreview path={session.path} allowedRoot={session.projectRoot} revision={session.revision} expectedFileSignature={session.fileSignature} onController={bind} onStateChange={observe} /></Suspense></div>
    <details className="agent-model-scene__info"><summary>模型信息</summary><dl>
      <dt>文件</dt><dd>{session.path}</dd>
      {state?.scene && <><dt>几何体</dt><dd>{state.scene.meshes.toLocaleString()} 个网格 · {state.scene.triangles.toLocaleString()} 个三角形</dd>
        <dt>边界尺寸</dt><dd>{state.scene.bounds.max.map((value, axis) => (value - state.scene!.bounds.min[axis]!).toPrecision(4)).join(' × ')}（文件坐标单位）</dd></>}
      <dt>更新方式</dt><dd>{session.autoRefresh ? '保留当前视角，跟随项目文件更新' : '自动监听不可用，可重新加载；当前模型仍可查看'}</dd>
      <dt>模型反馈</dt><dd>仅返回此场景的画面与版本</dd>
    </dl></details>
  </section>;
}

/** A workspace dock, with background conversations retained offscreen for their own tools. */
export function AgentModelPreviewWorkspace({ manager, projectRoot, conversationId, shown = true, onAvailable }: {
  manager: ServiceManager; projectRoot: string; conversationId: string | null;
  shown?: boolean; onAvailable?: (key: number | null) => void;
}): ReactElement {
  const { bridge, sessions, close } = useAgentModelPreview(manager);
  const workspaceKey = (path: string): string => /^[a-z]:|^[/\\]{2}/i.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path.replace(/\\/g, '/');
  const current = (session: AgentModelSession): boolean => workspaceKey(session.workspaceRoot ?? session.projectRoot) === workspaceKey(projectRoot)
    && session.conversationId === conversationId;
  const activeKey = sessions.find(current)?.key ?? null;
  useEffect(() => { onAvailable?.(activeKey); }, [activeKey, onAvailable]);
  return <div className={`agent-model-workspace${shown && activeKey !== null ? ' agent-model-workspace--open' : ''}`}>
    {sessions.map(session => <Scene key={session.key} session={session} bridge={bridge} visible={shown && current(session)} onClose={() => close(session.scope)} />)}
  </div>;
}
