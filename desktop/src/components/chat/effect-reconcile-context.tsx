import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { EffectVerdictInput } from './EffectReconcileCard';

/**
 * 谁来回答"那步到底做了没有"。
 *
 * 卡片本身只会摆问题；把判定写回引擎需要 CLI 的路径、工作目录和会话身份——
 * 那些属于宿主，不属于一条消息。走 context 而不是逐层 props，是因为聊天面板
 * 的 props 已经有几十个调用方，再穿一条只给某一种 notice 用的线会把签名变成
 * 杂物间。
 *
 * 默认实现明确拒绝：没人提供宿主时，按钮不能假装成功。
 */
export type EffectSettleRequest = EffectVerdictInput & { readonly sessionId: string };

export type EffectReconcileHost = {
  readonly settle: (request: EffectSettleRequest) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
};

const NO_HOST: EffectReconcileHost = {
  settle: async () => ({ ok: false, reason: 'no_host' }),
};

const EffectReconcileContext = createContext<EffectReconcileHost>(NO_HOST);

/**
 * 应用级安装点。
 *
 * 聊天消息挂在很深的树里，而宿主目标（CLI 路径、工作目录）在根组件手边。
 * 仓库里 hostAdapter 早就是这个形状：模块级单例，由根组件在启动时装一次。
 * 这里沿用而不是给整棵树套 provider，是因为根组件一次返回几百行 JSX，
 * 为一条 notice 把它整体包一层，改动面远大于收益。
 */
let installedHost: EffectReconcileHost | null = null;

export function installEffectReconcileHost(host: EffectReconcileHost | null): void {
  installedHost = host;
}

export function EffectReconcileProvider(props: {
  readonly host: EffectReconcileHost;
  readonly children: ReactNode;
}): ReactElement {
  return <EffectReconcileContext.Provider value={props.host}>{props.children}</EffectReconcileContext.Provider>;
}

export function useEffectReconcileHost(): EffectReconcileHost {
  const fromContext = useContext(EffectReconcileContext);
  if (fromContext !== NO_HOST) return fromContext;
  return installedHost ?? NO_HOST;
}
