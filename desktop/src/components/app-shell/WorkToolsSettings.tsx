import { useState, type ReactElement } from 'react'
import catalog from '../../tooling/tool-catalog.generated.json'
import type { ToolPackageHealth } from '../../services-host/methods'
import {
  derivePackageView,
  UI_STATE_LABEL,
  type ToolPlatformState,
} from '../../tooling/use-tool-platform-state'

export interface WorkToolsSettingsProps {
  readonly platform?: ToolPlatformState | null
  readonly selection?: { computer: boolean; browserDebug: boolean; cad: boolean }
  readonly onConfigure?: () => void
}

const GROUPS = ['全部', '办公文档', '浏览器', '电脑控制', 'CAD / EDA', '其他工具'] as const
type Group = (typeof GROUPS)[number]
const INFO: Record<string, { group: Group; description: string }> = {
  officecli: { group: '办公文档', description: '创建、编辑与校验 Word、Excel、PowerPoint 文档。' },
  playwright: { group: '浏览器', description: '网页导航、内容读取、表单交互与截图。' },
  'chrome-devtools': { group: '浏览器', description: '浏览器调试、网络请求检查与性能分析。' },
  'windows-mcp': { group: '电脑控制', description: '屏幕读取、点击、键入与应用操作。' },
  'solidworks-mcp': { group: 'CAD / EDA', description: '连接 SolidWorks，调用建模与文档工具。' },
  'autocad-mcp': {
    group: 'CAD / EDA',
    description: '绘制与编辑图元、尺寸标注、图层和工程图交付。',
  },
  'kicad-mcp': { group: 'CAD / EDA', description: '连接 KiCad，处理电子设计与 PCB 工程。' },
  'jlceda-mcp': { group: 'CAD / EDA', description: '连接嘉立创 EDA 专业版，处理电子设计工程。' },
  'freecad-mcp': { group: 'CAD / EDA', description: '连接 FreeCAD，处理三维模型与工程文档。' },
  'blender-mcp': { group: 'CAD / EDA', description: 'Blender 场景、对象与素材操作。' },
}
type CatalogPackage = (typeof catalog.packages)[number]

export function selectedWorkPackages(
  selection: NonNullable<WorkToolsSettingsProps['selection']>,
): readonly string[] {
  const id = selection.cad
    ? selection.browserDebug
      ? 'work.cad-browser-debug.v1'
      : 'work.cad.v1'
    : selection.browserDebug
      ? 'work.browser-debug.v1'
      : 'work.core.v1'
  return catalog.profiles[id].filter(
    (packageId) => selection.computer || packageId !== 'windows-mcp',
  )
}

function PackageRow({
  item,
  pkg,
  platform,
  selected,
}: {
  item: CatalogPackage
  pkg?: ToolPackageHealth
  platform?: ToolPlatformState | null
  selected?: boolean
}): ReactElement {
  const connected = platform?.serviceHealth === 'ready' && !platform.transportError
  const actionState = platform?.actions[item.id]
  const view = connected && pkg ? derivePackageView(pkg, actionState) : null
  const checking = connected && platform.loading && !actionState
  const notInstalled = view?.uiState === 'unusable' && pkg?.state === 'not-installed'
  const label = checking
    ? '检测中…'
    : notInstalled
      ? '未安装'
      : view
        ? UI_STATE_LABEL[view.uiState]
        : '未检测'
  const busy =
    checking ||
    !view ||
    ['installing', 'verifying', 'installing-browser', 'checking'].includes(view.uiState)
  const action = busy ? 'none' : view.action
  const actionLabel =
    action === 'install'
      ? '安装'
      : action === 'install-browser'
        ? '安装浏览器'
        : action === 'retry'
          ? '重试'
          : action === 'uninstall'
            ? '卸载'
            : null
  const info = INFO[item.id]
  const tools = connected && pkg ? pkg.expectedTools : item.expectedTools
  return (
    <article className="work-tools__package" aria-label={item.displayName}>
      <div className="work-tools__package-head">
        <div className="work-tools__identity">
          <h4>{item.displayName}</h4>
          <span className="work-tools__selection">
            {selected === undefined ? '' : selected ? '配置中已选用' : '配置中未选用'}
          </span>
        </div>
        <span
          className={`work-tools__state work-tools__state--${!checking && view?.uiState === 'available' ? 'ok' : !checking && !notInstalled && view && ['unusable', 'install-failed'].includes(view.uiState) ? 'err' : 'pending'}`}
          role="status"
        >
          {label}
        </span>
        {actionLabel && (
          <button
            type="button"
            className="work-tools__action"
            aria-label={`${actionLabel} ${item.displayName}`}
            onClick={() => {
              if (!platform) return
              if (action === 'install-browser') void platform.installBrowser(item.id)
              else if (action === 'uninstall') void platform.uninstall(item.id)
              else void platform.install(item.id)
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
      <p className="work-tools__description">
        {info?.description ?? '由工具服务提供的扩展工具包。'}
      </p>
      <div className="work-tools__package-meta">
        <span>{info?.group ?? '其他工具'}</span>
        <span>
          {pkg && connected ? '检测版本' : '目录版本'}{' '}
          {pkg && connected ? pkg.version : item.version}
        </span>
      </div>
      {!checking && view && view.uiState !== 'available' && (
        <p className="work-tools__detail">{view.message}</p>
      )}
      <details className="work-tools__definitions">
        <summary>查看 {tools.length} 项工具定义</summary>
        <p>
          这是工具清单中的定义。
          {connected && pkg?.protocol === 'ok'
            ? '本次协议检查已通过。'
            : '当前未确认会话中的实际加载结果。'}
          是否可调用还取决于运行状态、任务配置和操作授权。
        </p>
        <div className="work-tools__tool-names">
          {tools.map((name) => (
            <code key={name}>{name}</code>
          ))}
        </div>
      </details>
    </article>
  )
}

export function WorkToolsSettings({
  platform,
  selection,
  onConfigure,
}: WorkToolsSettingsProps): ReactElement {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<Group>('全部')
  const packages: CatalogPackage[] = [...catalog.packages]
  for (const pkg of platform?.packages ?? []) {
    if (!packages.some((item) => item.id === pkg.id))
      packages.push({
        id: pkg.id,
        displayName: pkg.displayName,
        version: pkg.version,
        expectedTools: [...pkg.expectedTools],
      })
  }
  const selected = selection ? selectedWorkPackages(selection) : undefined
  const normalized = query.trim().toLocaleLowerCase()
  const shown = packages.filter(
    (item) =>
      (group === '全部' || (INFO[item.id]?.group ?? '其他工具') === group) &&
      [item.id, item.displayName, INFO[item.id]?.description ?? '', ...item.expectedTools].some(
        (text) => text.toLocaleLowerCase().includes(normalized),
      ),
  )
  const connected = platform?.serviceHealth === 'ready' && !platform.transportError
  return (
    <section className="work-tools" aria-label="工具目录">
      <div className="work-tools__catalog-heading">
        <h4>
          工具目录 <span>{packages.length} 个工具包</span>
        </h4>
        {onConfigure && (
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={onConfigure}
          >
            选择任务能力
          </button>
        )}
        {platform && (
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={() => void platform.refresh()}
            disabled={platform.serviceHealth !== 'ready' || platform.loading}
          >
            {platform.loading ? '正在检测…' : '重新检测'}
          </button>
        )}
      </div>
      <p className="settings-modal__desc">
        查看支持的工具与安装状态。下方的能力开关决定 Work 任务选用哪些工具包，保存后用于后续任务。
      </p>
      {!connected && (
        <p className="work-tools__notice" role="status">
          {platform?.transportError || '工具服务未连接，暂时无法检测安装与运行状态。'}{' '}
          支持清单仍然可查看。
        </p>
      )}
      <div className="work-tools__filters">
        <input
          type="search"
          className="settings-modal__input"
          aria-label="搜索工具"
          placeholder="搜索工具、软件或操作名称"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="settings-modal__input"
          aria-label="工具分类"
          value={group}
          onChange={(event) => setGroup(event.target.value as Group)}
        >
          {GROUPS.filter(
            (name) => name !== '其他工具' || packages.some((item) => !INFO[item.id]),
          ).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      <p className="work-tools__result-count" aria-live="polite">
        显示 {shown.length} / {packages.length} 个工具包
      </p>
      <div className="work-tools__packages">
        {shown.map((item) => (
          <PackageRow
            key={item.id}
            item={item}
            pkg={platform?.packages.find((pkg) => pkg.id === item.id)}
            platform={platform}
            selected={selected?.includes(item.id)}
          />
        ))}
      </div>
      {shown.length === 0 && (
        <div className="work-tools__empty">
          <p>没有匹配的工具。可以尝试软件名称，或清除筛选。</p>
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={() => {
              setQuery('')
              setGroup('全部')
            }}
          >
            清除筛选
          </button>
        </div>
      )}
    </section>
  )
}
