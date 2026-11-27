import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { CodeMode, TopLevelMode } from '../../host-adapter/types';
import { PERMISSION_LEVELS, type PermissionLevel } from '../../permission/permission-policy';
import type { Appearance } from '../../settings/appearance-store';
import type { WorkspaceEntry } from '../app-shell/LeftRail';
import type { SettingsTab } from '../app-shell/SettingsModal';
import type { ModelChoice } from '../chat/ModelSelector';

export type PaletteGroup = 'content' | 'action';

export interface CommandAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface CommandExecutionOrigin {
  readonly x: number;
  readonly y: number;
}

export interface CommandOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly badge?: string;
  readonly active?: boolean;
  readonly keywords?: readonly string[];
  readonly availability?: () => CommandAvailability;
  readonly run: (origin?: CommandExecutionOrigin) => void | Promise<void>;
}

export interface CommandStep {
  readonly title: string;
  readonly placeholder: string;
  readonly items: readonly CommandOption[];
}

export interface PaletteCommand {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly label: string;
  readonly description?: string;
  readonly badge?: string;
  readonly keywords: readonly string[];
  readonly shortcut?: readonly string[];
  readonly availability: () => CommandAvailability;
  readonly getStep?: () => CommandStep;
  readonly run?: (origin?: CommandExecutionOrigin) => void | Promise<void>;
}

export interface CommandPaletteHostContext {
  readonly codeMode?: CodeMode;
  readonly onCodeModeChange?: (mode: CodeMode) => void;
  readonly permissionLevel?: PermissionLevel;
  readonly onPermissionLevelChange?: (level: PermissionLevel) => void;
  readonly configuredModel?: string;
  readonly poolModel?: string;
  readonly savedProfiles?: readonly ModelChoice[];
  readonly activeProfileId?: string;
  readonly onSelectConfigured?: () => void;
  readonly onSelectPool?: (model: string) => void;
  readonly onSelectProfile?: (id: string) => void;
  readonly onCompact?: () => void;
  readonly compactAvailable?: boolean;
}

export interface PaletteBuilderInput {
  readonly topMode: TopLevelMode;
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly currentWorkspaceId: string;
  readonly onSwitchWorkspace: (id: string) => void;
  readonly onOpenFolder: () => void;
  readonly sessions: readonly ConversationSession[];
  readonly activeSessionId: string | null;
  readonly runningSessionIds: ReadonlySet<string>;
  readonly onSelectSession: (id: string) => void;
  readonly onNewSession: () => void;
  readonly onArchiveSession: (id: string) => void;
  readonly rightRailOpen: boolean;
  readonly onToggleRightRail: () => void;
  readonly leftRailCollapsed: boolean;
  readonly onToggleLeftRail: () => void;
  readonly browserOpen: boolean;
  readonly onToggleBrowser: () => void;
  readonly terminalAvailable: boolean;
  readonly terminalOpen: boolean;
  readonly onToggleTerminal: () => void;
  readonly onOpenActivityCenter?: () => void;
  readonly activityCount: number;
  readonly onOpenSettingsTab: (tab: SettingsTab) => void;
  readonly onOpenRemote: () => void;
  readonly appearancePreference: Appearance;
  readonly onSetAppearance: (value: Appearance, origin?: CommandExecutionOrigin) => void;
  readonly host?: CommandPaletteHostContext;
}

const AVAILABLE: CommandAvailability = { enabled: true };

const CODE_MODE_ITEMS: readonly { readonly id: CodeMode; readonly label: string; readonly description: string }[] = [
  { id: 'agent', label: '执行 (Agent)', description: '自主读写文件与运行命令' },
  { id: 'plan', label: '计划 (Plan)', description: '先梳理方案，再开始实现' },
  { id: 'chat', label: '对话 (Chat)', description: '仅讨论代码与思路，不修改文件' },
  { id: 'cognition', label: '偏好 (Cognition)', description: '沟通协作偏好与工作习惯' },
];

const APPEARANCE_ITEMS: readonly { readonly value: Appearance; readonly label: string; readonly description: string }[] = [
  { value: 'light', label: '浅色主题', description: '保持纸感明亮界面' },
  { value: 'dark', label: '深色主题', description: '切换至沉稳暗色界面' },
  { value: 'system', label: '跟随系统', description: '自动匹配操作系统外观' },
];

export function buildPaletteCommands(input: PaletteBuilderInput): readonly PaletteCommand[] {
  const activeSession = input.sessions.find((s) => s.id === input.activeSessionId) ?? null;
  const activeSessionRunning = activeSession ? input.runningSessionIds.has(activeSession.id) : false;

  const workspaceCommands: PaletteCommand[] = input.workspaces
    .filter((ws) => ws.id !== input.currentWorkspaceId)
    .map((ws) => ({
      id: `ws:${ws.id}`,
      group: 'content',
      label: `切换项目：${ws.name}`,
      description: ws.root,
      badge: '项目',
      keywords: ['workspace', 'project', '工作区', '项目', ws.name, ws.root],
      availability: () => AVAILABLE,
      run: () => input.onSwitchWorkspace(ws.id),
    }));

  const sessionCommands: PaletteCommand[] = input.sessions
    .filter((s) => !s.archivedAt)
    .slice(0, 12)
    .map((s) => {
      const running = input.runningSessionIds.has(s.id);
      return {
        id: `session:${s.id}`,
        group: 'content',
        label: s.title || '新任务',
        description: s.id === input.activeSessionId ? '当前会话' : s.kind === 'work' ? 'Work 会话' : 'Code 会话',
        badge: running ? '运行中' : s.kind === 'work' ? 'Work' : 'Code',
        keywords: ['session', 'chat', '会话', '任务', s.title, s.kind],
        availability: () => AVAILABLE,
        run: () => input.onSelectSession(s.id),
      };
    });

  const actionCommands: PaletteCommand[] = [
    {
      id: 'action:new-session',
      group: 'action',
      label: '新建任务',
      description: '在当前工作区开启新对话',
      keywords: ['new', 'task', 'session', '新建', '新任务', '对话'],
      shortcut: ['Mod', 'N'],
      availability: () => AVAILABLE,
      run: () => input.onNewSession(),
    },
    {
      id: 'action:toggle-top-mode',
      group: 'action',
      label: input.topMode === 'code' ? '切换到 Work 模式' : '切换到 Code 模式',
      description: input.topMode === 'code' ? '切换至文档、表格与成果工作台' : '切换至代码编辑与开发工作台',
      keywords: ['mode', 'code', 'work', '模式', '切换'],
      availability: () => (input.onTopModeChange ? AVAILABLE : { enabled: false, reason: '当前视图不支持切换模式' }),
      run: () => input.onTopModeChange?.(input.topMode === 'code' ? 'work' : 'code'),
    },
    {
      id: 'action:code-mode',
      group: 'action',
      label: '切换 Code 子模式…',
      description: '选择 执行 / 计划 / 对话 / 偏好',
      keywords: ['agent', 'plan', 'chat', 'cognition', '子模式', '计划', '执行'],
      availability: () =>
        input.host?.onCodeModeChange
          ? AVAILABLE
          : { enabled: false, reason: '未接入模式控制器' },
      getStep: () => ({
        title: '切换 Code 子模式',
        placeholder: '筛选子模式…',
        items: CODE_MODE_ITEMS.map((item) => ({
          id: `code-mode:${item.id}`,
          label: item.label,
          description: item.description,
          active: input.topMode === 'code' && input.host?.codeMode === item.id,
          keywords: [item.id, item.label, item.description],
          run: () => {
            if (input.topMode !== 'code') input.onTopModeChange?.('code');
            input.host?.onCodeModeChange?.(item.id);
          },
        })),
      }),
    },
    {
      id: 'action:model',
      group: 'action',
      label: '切换当前模型…',
      description: input.host?.poolModel || input.host?.configuredModel || '默认模型',
      keywords: ['model', 'llm', '模型', '算力池', '配置'],
      availability: () =>
        input.host?.onSelectConfigured || input.host?.onSelectPool
          ? AVAILABLE
          : { enabled: false, reason: '当前未接入模型切换' },
      getStep: () => {
        const ownLabel = input.host?.configuredModel?.trim() || '默认模型';
        const activePool = input.host?.poolModel?.trim() ?? '';
        const activeProfileId = input.host?.activeProfileId ?? '';
        const options: CommandOption[] = [
          {
            id: 'model:own',
            label: ownLabel,
            description: '使用主连接配置模型',
            active: !activePool && !activeProfileId,
            keywords: ['default', 'own', ownLabel, '默认', '配置'],
            run: () => input.host?.onSelectConfigured?.(),
          },
          ...(input.host?.savedProfiles ?? []).map((p) => ({
            id: `model:profile:${p.id}`,
            label: p.label,
            description: p.hint,
            active: !activePool && activeProfileId === p.id,
            keywords: [p.label, p.hint, 'profile', '配置'],
            run: () => input.host?.onSelectProfile?.(p.id),
          })),
        ];
        if (activePool) {
          options.push({
            id: `model:pool:${activePool}`,
            label: activePool,
            description: '当前免费算力池模型',
            active: true,
            keywords: [activePool, 'pool', '算力池'],
            run: () => input.host?.onSelectPool?.(activePool),
          });
        }
        return {
          title: '切换当前模型',
          placeholder: '搜索已保存配置或模型…',
          items: options,
        };
      },
    },
    {
      id: 'action:permission',
      group: 'action',
      label: '调整权限档位…',
      description: PERMISSION_LEVELS.find((l) => l.value === input.host?.permissionLevel)?.label ?? '当前权限',
      keywords: ['permission', 'approval', '权限', '只读', '审批'],
      availability: () =>
        input.host?.onPermissionLevelChange
          ? AVAILABLE
          : { enabled: false, reason: '当前会话不支持调整权限' },
      getStep: () => ({
        title: '调整权限档位',
        placeholder: '选择权限档位…',
        items: PERMISSION_LEVELS.map((level) => ({
          id: `perm:${level.value}`,
          label: level.label,
          description: level.hint,
          active: input.host?.permissionLevel === level.value,
          keywords: [level.value, level.label, level.description, level.hint],
          run: () => input.host?.onPermissionLevelChange?.(level.value),
        })),
      }),
    },
    {
      id: 'action:appearance',
      group: 'action',
      label: '切换界面外观…',
      description: APPEARANCE_ITEMS.find((i) => i.value === input.appearancePreference)?.label,
      keywords: ['theme', 'dark', 'light', 'appearance', '主题', '深色', '浅色', '外观'],
      availability: () => AVAILABLE,
      getStep: () => ({
        title: '切换界面外观',
        placeholder: '选择浅色、深色或跟随系统…',
        items: APPEARANCE_ITEMS.map((item) => ({
          id: `appearance:${item.value}`,
          label: item.label,
          description: item.description,
          active: input.appearancePreference === item.value,
          keywords: [item.value, item.label, item.description],
          run: (origin) => input.onSetAppearance(item.value, origin),
        })),
      }),
    },
    {
      id: 'action:toggle-right-rail',
      group: 'action',
      label: input.rightRailOpen ? '收起结果与文件侧栏' : '打开结果与文件侧栏',
      keywords: ['file', 'tree', 'preview', 'right', '文件', '侧栏', '预览', '结果'],
      shortcut: ['Mod', 'Shift', 'B'],
      availability: () => AVAILABLE,
      run: () => input.onToggleRightRail(),
    },
    {
      id: 'action:toggle-left-rail',
      group: 'action',
      label: input.leftRailCollapsed ? '展开左侧任务栏' : '收起左侧任务栏',
      keywords: ['sidebar', 'left', 'rail', '侧栏', '导航'],
      shortcut: ['Mod', 'B'],
      availability: () => AVAILABLE,
      run: () => input.onToggleLeftRail(),
    },
    {
      id: 'action:toggle-browser',
      group: 'action',
      label: input.browserOpen ? '关闭浏览器侧栏' : '打开浏览器侧栏',
      keywords: ['browser', 'web', '浏览器', '网页'],
      shortcut: ['Option', 'Mod', 'B'],
      availability: () => AVAILABLE,
      run: () => input.onToggleBrowser(),
    },
    {
      id: 'action:toggle-terminal',
      group: 'action',
      label: input.terminalOpen ? '关闭集成终端' : '打开集成终端',
      keywords: ['terminal', 'shell', 'pty', '终端'],
      shortcut: ['Control', '`'],
      availability: () =>
        input.terminalAvailable
          ? AVAILABLE
          : { enabled: false, reason: '仅在 macOS 桌面应用且已打开项目时可用' },
      run: () => input.onToggleTerminal(),
    },
    {
      id: 'action:activity',
      group: 'action',
      label: '查看运行中的任务',
      description: input.activityCount > 0 ? `${input.activityCount} 项进行中` : '当前无运行中任务',
      keywords: ['activity', 'running', 'background', '运行中', '后台任务'],
      availability: () =>
        input.onOpenActivityCenter
          ? AVAILABLE
          : { enabled: false, reason: '当前视图未挂载后台任务中心' },
      run: () => input.onOpenActivityCenter?.(),
    },
    {
      id: 'action:compact',
      group: 'action',
      label: '压缩当前对话上下文',
      keywords: ['compact', 'context', '压缩', '上下文'],
      availability: () =>
        input.host?.onCompact && input.host.compactAvailable
          ? AVAILABLE
          : { enabled: false, reason: '当前没有可压缩的活跃对话进程' },
      run: () => input.host?.onCompact?.(),
    },
    {
      id: 'action:archive-current',
      group: 'action',
      label: '归档当前会话',
      description: activeSession ? activeSession.title : undefined,
      keywords: ['archive', '归档', '收起会话'],
      availability: () => {
        if (!activeSession) return { enabled: false, reason: '当前没有可归档的活动会话' };
        if (activeSession.archivedAt) return { enabled: false, reason: '当前会话已在归档中' };
        if (activeSessionRunning) return { enabled: false, reason: '任务正在运行中，请先停止再归档' };
        return AVAILABLE;
      },
      run: () => {
        if (!activeSession || activeSession.archivedAt || activeSessionRunning) {
          throw new Error('会话状态已变化，当前无法归档');
        }
        input.onArchiveSession(activeSession.id);
      },
    },
    {
      id: 'action:open-folder',
      group: 'action',
      label: '打开本地项目文件夹…',
      keywords: ['open', 'folder', 'workspace', '打开', '项目', '文件夹'],
      shortcut: ['Mod', 'O'],
      availability: () => AVAILABLE,
      run: () => input.onOpenFolder(),
    },
    {
      id: 'action:remote',
      group: 'action',
      label: '打开远程配对连接',
      keywords: ['remote', 'mobile', 'qr', '远程', '手机', '配对'],
      availability: () => AVAILABLE,
      run: () => input.onOpenRemote(),
    },
    {
      id: 'action:settings-connection',
      group: 'action',
      label: '打开设置：模型与连接',
      keywords: ['settings', 'api', 'key', 'model', '设置', '连接', '密钥'],
      shortcut: ['Mod', ','],
      availability: () => AVAILABLE,
      run: () => input.onOpenSettingsTab('connection'),
    },
    {
      id: 'action:settings-tools',
      group: 'action',
      label: '打开设置：工具与技能',
      keywords: ['settings', 'tools', 'skills', 'mcp', '设置', '工具', '技能'],
      availability: () => AVAILABLE,
      run: () => input.onOpenSettingsTab('tools'),
    },
    {
      id: 'action:settings-appearance',
      group: 'action',
      label: '打开设置：外观',
      keywords: ['settings', 'appearance', 'theme', '设置', '外观'],
      availability: () => AVAILABLE,
      run: () => input.onOpenSettingsTab('appearance'),
    },
  ];

  return [...workspaceCommands, ...sessionCommands, ...actionCommands];
}

export function matchesPaletteQuery(
  query: string,
  fields: readonly (string | undefined)[],
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const haystack = fields
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
