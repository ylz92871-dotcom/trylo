import type { ReactElement } from 'react';
import type { CodeMode } from '../../host-adapter/types';
import { LandingSurface } from '../landing/LandingSurface';

export interface EmptyStateProps {
  readonly codeMode: CodeMode;
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  return <LandingSurface headline={props.codeMode === 'cognition' ? 'Trylo 怎样与你合作？' : '今天，想推进什么？'} subtitle={props.codeMode === 'plan' ? '先梳理方案，再开始实现。' : undefined} />;
}

export function WorkLanding(): ReactElement {
  return <LandingSurface headline="今天，想完成什么？" />;
}
