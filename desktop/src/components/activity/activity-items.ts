import { workspaceKey, type ConversationSession, type WorkspaceConversationHistory } from '../../host-adapter/conversation-history';
import type { ActiveCodeRun } from '../../runtime/runtime-types';
import type { ActivityItem } from './BackgroundActivityCenter';

export interface ActivityWorkspace { readonly id: string; readonly root: string; readonly name: string; }
export interface ActivityNavigation { readonly workspace: ActivityWorkspace; readonly session: ConversationSession; }
const status = { spawning: '正在启动', ready: '准备就绪', busy: '执行中', idle: '等待下一步', exited: '已退出' };

/** App remains the owner of navigation and stop; this projection performs no IO. */
export function buildActivityItems(props: {
  readonly runs: readonly ActiveCodeRun[];
  readonly workspaces: readonly ActivityWorkspace[];
  readonly histories: Readonly<Record<string, WorkspaceConversationHistory>>;
  readonly onStop: (projectKey: string, conversationId: string) => void | Promise<void>;
  readonly onJump: (target: ActivityNavigation) => void;
}): readonly ActivityItem[] {
  return props.runs.map(run => {
    const workspace = props.workspaces.find(item => workspaceKey(item.root) === run.projectKey);
    const session = props.histories[run.projectKey]?.conversations[run.conversationId]?.session;
    const tail = run.projectKey.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      id: `${run.projectKey}:${run.conversationId}:${run.runId}`,
      kind: session?.kind ?? 'unknown',
      conversationId: run.conversationId,
      workspaceLabel: workspace?.name ?? tail ?? run.projectKey,
      title: session?.title || '运行中的会话',
      statusLabel: session ? status[run.bindingState] : '会话信息暂不可用',
      startedAt: run.startedAt,
      onStop: () => props.onStop(run.projectKey, run.conversationId),
      onJump: workspace && session ? () => props.onJump({ workspace, session }) : undefined,
    };
  });
}
