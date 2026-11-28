import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import catalog from '../../tooling/tool-catalog.generated.json';
import {
  derivePackageView,
  UI_STATE_LABEL,
  type ToolPlatformState,
} from '../../tooling/use-tool-platform-state';
import type { LearningPort } from '../../learning/learning-port';
import type { SkillLearningRuntime } from '../../skill-learning/cli';
import { isMacPlatform } from '../../utils/platform';
import { selectedWorkPackages } from './WorkToolsSettings';
import { WorkspaceSkillInstall } from './WorkspaceSkillInstall';
import { LearnedSkillsPanel } from './LearnedSkillsPanel';

export interface LeftRailToolsPaneProps {
  readonly workspaceRoot?: string;
  readonly toolPlatform?: ToolPlatformState | null;
  readonly learningPort?: LearningPort | null;
  readonly skillLearningRuntime?: SkillLearningRuntime;
  readonly workBrowserDebug?: boolean;
  readonly workCad?: boolean;
  readonly onOpenToolsSettings?: () => void;
  readonly onOpenLearningPending?: () => void;
}

type ToolsSubTab = 'tools' | 'skills';
type SkillSource = 'installed' | 'learned';
type CatalogPackage = (typeof catalog.packages)[number];

interface SkillSummary {
  readonly workspaceDirectory?: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

interface SkillDetailState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly content: string;
  readonly error: string | null;
}

const WINDOWS_ONLY_PACKAGE_IDS = new Set([
  'windows-mcp',
  'solidworks-mcp',
  'autocad-mcp',
  'kicad-mcp',
  'jlceda-mcp',
  'freecad-mcp',
  'blender-mcp',
]);

const PACKAGE_INFO: Readonly<Record<string, { group: string; description: string }>> = {
  officecli: { group: '办公文档', description: '创建、编辑与校验 Word、Excel、PowerPoint 文档。' },
  playwright: { group: '浏览器', description: '网页导航、内容读取、表单交互与截图。' },
  'chrome-devtools': { group: '浏览器', description: '浏览器调试、网络请求检查与性能分析。' },
  'windows-mcp': { group: '电脑控制', description: '屏幕读取、点击、键入与应用操作。' },
  'solidworks-mcp': { group: 'CAD / EDA', description: '连接 SolidWorks，调用建模与文档工具。' },
  'autocad-mcp': { group: 'CAD / EDA', description: '绘制与编辑图元、尺寸标注、图层和工程图交付。' },
  'kicad-mcp': { group: 'CAD / EDA', description: '连接 KiCad，处理电子设计与 PCB 工程。' },
  'jlceda-mcp': { group: 'CAD / EDA', description: '连接嘉立创 EDA 专业版，处理电子设计工程。' },
  'freecad-mcp': { group: 'CAD / EDA', description: '连接 FreeCAD，处理三维模型与工程文档。' },
  'blender-mcp': { group: 'CAD / EDA', description: 'Blender 场景、对象与素材操作。' },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSkill(raw: unknown): SkillSummary | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = asText(rec.name ?? rec.title ?? rec.id).trim();
  if (!name) return null;
  return {
    name,
    category: asText(rec.category) || '未分类',
    description: asText(rec.description ?? rec.summary) || '(无描述)',
  };
}

export function LeftRailToolsPane(props: LeftRailToolsPaneProps): ReactElement {
  const [subTab, setSubTab] = useState<ToolsSubTab>('tools');
  const [skillSource, setSkillSource] = useState<SkillSource>('installed');
  const [query, setQuery] = useState('');
  const [skillPhase, setSkillPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetailState>({
    status: 'loading',
    content: '',
    error: null,
  });
  const mounted = useRef(true);
  const viewReqId = useRef(0);
  const listReqId = useRef(0);
  const { workspaceRoot, learningPort } = props;
  const workspaceSkills = props.toolPlatform?.workspaceSkills;
  const workspaceScope = useRef(workspaceRoot);
  workspaceScope.current = workspaceRoot;

  useEffect(() => {
    viewReqId.current++;
    setExpandedSkill(null);
    setSkills([]);
    setSkillPhase('idle');
  }, [workspaceRoot]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSkills = useCallback(async (): Promise<void> => {
    setSkillPhase('loading');
    setSkillError(null);
    const req = ++listReqId.current;
    const [workspace, library] = await Promise.allSettled([
      workspaceRoot && workspaceSkills ? workspaceSkills({ op: 'list', workspaceRoot }) : undefined,
      learningPort?.skills({ op: 'list' }),
    ]);
    if (!mounted.current || req !== listReqId.current || workspaceScope.current !== workspaceRoot) return;
    const local = workspace.status === 'fulfilled' ? workspace.value : undefined;
    const shared = library.status === 'fulfilled' ? library.value : undefined;
    if (!local?.ok && !shared?.ok) {
      setSkillError(local?.error ?? shared?.error ?? '已安装技能服务尚未就绪。');
      setSkills([]);
      setSkillPhase('error');
      return;
    }
    const skillsByName = new Map<string, SkillSummary>();
    for (const raw of Array.isArray(shared?.skills) ? shared.skills : []) {
      const skill = normalizeSkill(raw);
      if (skill) skillsByName.set(skill.name, skill);
    }
    for (const { name, directory, category, description } of local?.skills ?? []) {
      skillsByName.set(name, { name, category, description, workspaceDirectory: directory });
    }
    setSkills([...skillsByName.values()]);
    setSkillPhase('ready');
  }, [workspaceRoot, workspaceSkills, learningPort]);

  useEffect(() => {
    if (subTab === 'skills' && skillSource === 'installed') {
      void loadSkills();
    }
  }, [subTab, skillSource, loadSkills]);

  const toggleSkillDetail = async (skill: SkillSummary): Promise<void> => {
    const port = props.learningPort;
    if (expandedSkill === skill.name) {
      setExpandedSkill(null);
      return;
    }
    const req = ++viewReqId.current;
    setExpandedSkill(skill.name);
    setSkillDetail({ status: 'loading', content: '', error: null });
    try {
      const res = skill.workspaceDirectory && workspaceSkills && workspaceRoot
        ? await workspaceSkills({ op: 'view', workspaceRoot, directory: skill.workspaceDirectory })
        : await port?.skills({ op: 'view', name: skill.name });
      if (!mounted.current || req !== viewReqId.current || workspaceScope.current !== workspaceRoot) return;
      if (!res?.ok) {
        setSkillDetail({ status: 'error', content: '', error: res?.error ?? '已安装技能服务尚未就绪。' });
        return;
      }
      setSkillDetail({ status: 'ready', content: asText(res.content) || '(技能内容为空)', error: null });
    } catch (err) {
      if (!mounted.current || req !== viewReqId.current || workspaceScope.current !== workspaceRoot) return;
      setSkillDetail({
        status: 'error',
        content: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const mac = isMacPlatform();
  const platform = props.toolPlatform;
  const allPackages: CatalogPackage[] = [...catalog.packages];
  for (const pkg of platform?.packages ?? []) {
    if (!allPackages.some((item) => item.id === pkg.id)) {
      allPackages.push({
        id: pkg.id,
        displayName: pkg.displayName,
        version: pkg.version,
        expectedTools: [...pkg.expectedTools],
      });
    }
  }
  const packages = mac
    ? allPackages.filter(
        (item) =>
          !WINDOWS_ONLY_PACKAGE_IDS.has(item.id) ||
          platform?.packages.some((pkg) => pkg.id === item.id && pkg.available === true),
      )
    : allPackages;

  const selectedPackages =
    props.workBrowserDebug !== undefined || props.workCad !== undefined
      ? selectedWorkPackages({
          computer: true,
          browserDebug: Boolean(props.workBrowserDebug),
          cad: Boolean(props.workCad),
        })
      : undefined;

  const normalizedQuery = query.trim().toLowerCase();
  const shownPackages = packages.filter((item) => {
    if (!normalizedQuery) return true;
    const info = PACKAGE_INFO[item.id];
    return [item.id, item.displayName, info?.group ?? '', info?.description ?? '', ...item.expectedTools].some(
      (text) => text.toLowerCase().includes(normalizedQuery),
    );
  });

  const shownSkills = skills.filter((skill) => {
    if (!normalizedQuery) return true;
    return [skill.name, skill.category, skill.description].some((text) =>
      text.toLowerCase().includes(normalizedQuery),
    );
  });

  const connected = platform?.serviceHealth === 'ready' && !platform.transportError;
  const canRefreshTools = Boolean(platform && platform.serviceHealth === 'ready' && !platform.loading);
  const showSearch = subTab === 'tools' || skillSource === 'installed';

  return (
    <>
      <div className="left-rail__pane-header">
        <span className="left-rail__pane-title">工具与技能</span>
        <div className="left-rail__pane-actions">
          <button
            type="button"
            className="left-rail__pane-icon-btn"
            aria-label="刷新工具与技能"
            title="刷新"
            disabled={subTab === 'tools' ? !canRefreshTools : skillPhase === 'loading'}
            onClick={() => {
              if (subTab === 'tools') void platform?.refresh();
              else if (skillSource === 'installed') void loadSkills();
            }}
          >
            <RefreshCw size={14} strokeWidth={1.85} aria-hidden="true" />
          </button>
          {props.onOpenToolsSettings && (
            <button
              type="button"
              className="left-rail__pane-icon-btn"
              aria-label="打开完整工具设置"
              title="能力选择与高级设置"
              onClick={props.onOpenToolsSettings}
            >
              <SlidersHorizontal size={14} strokeWidth={1.85} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <WorkspaceSkillInstall key={workspaceRoot} workspaceRoot={workspaceRoot} query={workspaceSkills}
        connected={connected} needsReload={platform?.needsServiceReload} onInstalled={() => {
          if (!mounted.current || workspaceScope.current !== workspaceRoot) return;
          setQuery('');
          setSubTab('skills');
          setSkillSource('installed');
          if (subTab === 'skills' && skillSource === 'installed') void loadSkills();
        }} />

      <div className="left-rail__subtabs" role="tablist" aria-label="工具与技能视图">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'tools'}
          className={`left-rail__subtab${subTab === 'tools' ? ' left-rail__subtab--active' : ''}`}
          onClick={() => setSubTab('tools')}
        >
          <span>工具</span>
          <span className="left-rail__subtab-count">{packages.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'skills'}
          className={`left-rail__subtab${subTab === 'skills' ? ' left-rail__subtab--active' : ''}`}
          onClick={() => setSubTab('skills')}
        >
          <span>技能</span>
          {skillPhase === 'ready' && <span className="left-rail__subtab-count">{skills.length}</span>}
        </button>
      </div>

      {showSearch && (
        <div className="left-rail__search">
          <Search size={13} className="left-rail__search-icon" aria-hidden="true" />
          <input
            type="search"
            className="left-rail__search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={subTab === 'tools' ? '搜索工具或软件…' : '搜索技能名称…'}
            aria-label={subTab === 'tools' ? '搜索工具' : '搜索技能'}
            spellCheck={false}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="left-rail__search-clear"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              title="清空搜索"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className="left-rail__pane-body">
        {platform?.needsServiceReload && (
          <div className="left-rail__tool-notice" role="status">
            <span>工具服务需重载以启用新版本。</span>
            <button
              type="button"
              className="left-rail__tool-action"
              disabled={platform.loading}
              onClick={() => void platform.reloadService?.()}
            >
              重载服务
            </button>
          </div>
        )}
        {subTab === 'tools' ? (
          <>
            {!connected && (
              <div className="left-rail__tool-notice" role="status">
                <span>{platform?.transportError || '工具服务未连接，以下为支持清单。'}</span>
              </div>
            )}

            {shownPackages.length === 0 ? (
              <div className="left-rail__empty left-rail__empty--filtered">
                <span>没有匹配的工具</span>
                <button type="button" className="left-rail__clear-filter" onClick={() => setQuery('')}>
                  清除筛选
                </button>
              </div>
            ) : (
              <ul className="left-rail__tool-list" aria-label="工具目录">
                {shownPackages.map((item) => {
                  const pkg = platform?.packages.find((entry) => entry.id === item.id);
                  const actionState = platform?.actions[item.id];
                  const view = connected && pkg ? derivePackageView(pkg, actionState) : null;
                  const checking = Boolean(connected && platform?.loading && !actionState);
                  const core = ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools'].includes(item.id);
                  const stale = Boolean(connected && core && platform?.needsServiceReload);
                  const notInstalled = view?.uiState === 'unusable' && pkg?.state === 'not-installed' && !pkg.builtIn;
                  const statusText = checking
                    ? '检测中…'
                    : stale
                      ? '需重载'
                      : view && core
                        ? pkg?.available
                          ? '内置 · 可用'
                          : '内置 · 不可用'
                        : notInstalled
                          ? '未安装'
                          : view
                            ? UI_STATE_LABEL[view.uiState]
                            : '未检测';
                  const tone =
                    !checking && !stale && view?.uiState === 'available'
                      ? 'ok'
                      : !checking && !stale && !notInstalled && view && ['unusable', 'install-failed'].includes(view.uiState)
                        ? 'err'
                        : 'pending';
                  const busy =
                    checking ||
                    !view ||
                    ['installing', 'verifying', 'installing-browser', 'checking'].includes(view.uiState);
                  const action = busy || (core && view.action !== 'install-browser' && view.action !== 'repair-office') ? 'none' : view.action;
                  const actionLabel =
                    action === 'install'
                      ? '安装'
                      : action === 'install-browser'
                        ? '安装浏览器'
                        : action === 'repair-office'
                          ? '修复'
                        : action === 'retry'
                          ? '重试'
                          : action === 'uninstall'
                            ? '卸载'
                            : null;
                  const info = PACKAGE_INFO[item.id];
                  const tools = connected && pkg ? pkg.expectedTools : item.expectedTools;
                  const activeSelection = selectedPackages?.includes(item.id);

                  return (
                    <li key={item.id} className="left-rail__tool-card">
                      <div className="left-rail__tool-head">
                        <strong className="left-rail__tool-name">{item.displayName}</strong>
                        <span className={`left-rail__tool-state left-rail__tool-state--${tone}`} role="status">
                          {statusText}
                        </span>
                      </div>
                      <p className="left-rail__tool-desc">
                        {info?.description ?? '由工具服务提供的扩展工具包。'}
                      </p>
                      <div className="left-rail__tool-foot">
                        <span className="left-rail__tool-group">
                          {info?.group ?? '其他工具'}
                          {activeSelection ? ' · 已启用' : ''}
                        </span>
                        {actionLabel && (
                          <button
                            type="button"
                            className="left-rail__tool-action"
                            aria-label={`${actionLabel} ${item.displayName}`}
                            onClick={() => {
                              if (!platform) return;
                              if (action === 'install-browser') void platform.installBrowser(item.id);
                              else if (action === 'uninstall') void platform.uninstall(item.id);
                              else void platform.install(item.id);
                            }}
                          >
                            {actionLabel}
                          </button>
                        )}
                      </div>
                      {!checking && view && view.uiState !== 'available' && view.message !== statusText && (
                        <p className="left-rail__tool-detail">{view.message}</p>
                      )}
                      {tools.length > 0 && (
                        <details className="left-rail__tool-details">
                          <summary>查看 {tools.length} 项工具</summary>
                          <div className="left-rail__tool-chips">
                            {tools.map((name) => (
                              <code key={name}>{name}</code>
                            ))}
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {props.onOpenToolsSettings && (
              <button type="button" className="left-rail__pane-footer-link" onClick={props.onOpenToolsSettings}>
                <span>能力选择与高级设置</span>
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <>
            {props.skillLearningRuntime && (
              <div className="left-rail__skill-sources" role="group" aria-label="技能来源">
                <button
                  type="button"
                  className={`left-rail__filter-pill${skillSource === 'installed' ? ' left-rail__filter-pill--active' : ''}`}
                  aria-pressed={skillSource === 'installed'}
                  onClick={() => setSkillSource('installed')}
                >
                  已安装技能
                </button>
                <button
                  type="button"
                  className={`left-rail__filter-pill${skillSource === 'learned' ? ' left-rail__filter-pill--active' : ''}`}
                  aria-pressed={skillSource === 'learned'}
                  onClick={() => setSkillSource('learned')}
                >
                  任务学习
                </button>
              </div>
            )}

            {skillSource === 'learned' && props.skillLearningRuntime ? (
              <LearnedSkillsPanel runtime={props.skillLearningRuntime} />
            ) : skillPhase === 'loading' || skillPhase === 'idle' ? (
              <p className="left-rail__pane-status">正在读取已安装技能…</p>
            ) : skillPhase === 'error' ? (
              <div className="left-rail__skill-error" role="alert">
                <p>读不到技能列表：{skillError}</p>
                <button type="button" className="left-rail__clear-filter" onClick={() => void loadSkills()}>
                  重试
                </button>
              </div>
            ) : skills.length === 0 ? (
              <div className="left-rail__pane-empty">
                <strong>还没有已安装的技能</strong>
                <p>代理在任务中沉淀的可复用工作手册会先进入待审批提案，批准后安装到这里。</p>
                {props.onOpenLearningPending && (
                  <button
                    type="button"
                    className="left-rail__pane-empty-action"
                    onClick={props.onOpenLearningPending}
                  >
                    去看待审批提案
                  </button>
                )}
              </div>
            ) : shownSkills.length === 0 ? (
              <div className="left-rail__empty left-rail__empty--filtered">
                <span>没有匹配的技能</span>
                <button type="button" className="left-rail__clear-filter" onClick={() => setQuery('')}>
                  清除筛选
                </button>
              </div>
            ) : (
              <ul className="left-rail__skill-list" aria-label="已安装技能列表">
                {shownSkills.map((skill) => {
                  const open = expandedSkill === skill.name;
                  return (
                    <li key={skill.name} className="left-rail__skill-card">
                      <button
                        type="button"
                        className="left-rail__skill-head"
                        onClick={() => void toggleSkillDetail(skill)}
                        aria-expanded={open}
                      >
                        <span className="left-rail__skill-chev" aria-hidden="true">
                          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span className="left-rail__skill-name">{skill.name}</span>
                        <span className="left-rail__skill-cat">{skill.category}</span>
                      </button>
                      <p className="left-rail__skill-desc">{skill.description}</p>
                      {open && (
                        <div className="left-rail__skill-detail">
                          {skillDetail.status === 'loading' ? (
                            <span className="left-rail__pane-status">正在读取技能内容…</span>
                          ) : skillDetail.status === 'error' ? (
                            <span className="left-rail__activity-error" role="alert">
                              读不到技能内容：{skillDetail.error}
                            </span>
                          ) : (
                            <pre className="left-rail__skill-content">{skillDetail.content}</pre>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}
