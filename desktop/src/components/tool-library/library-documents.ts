import type { ToolLibraryItem } from '../../tool-library/client'
import type { ExpertConfiguration } from '../../../../new trylo cli/src/internal/subagent/experts/contracts'

export const toolAvailabilityLabel = {
  available: '环境可用',
  unavailable: '环境不可用',
  unknown: '尚未检测',
} as const
const lifecycleLabels: Readonly<Record<string, string>> = {
  draft: '草稿',
  quarantined: '隔离中',
  evaluating: '检查中',
  shadow: '影子版本',
  awaiting_approval: '等待审阅',
  validated: '已验证',
  active: '已启用',
  rejected: '已拒绝',
  suspended: '已停用',
  rolled_back: '已回退',
  retired: '已归档',
}
export const toolLifecycleLabel = (state: string | undefined): string =>
  state ? (lifecycleLabels[state] ?? '其他状态') : '现有运行时'

export function toolLibraryMarkdown(item: ToolLibraryItem): string {
  return `# ${item.name}\n\n${item.description}\n\n## 可做什么\n\n${item.capabilities.map((capability) => `- ${capability}`).join('\n') || '目录没有单独列出能力。'}\n\n## 调用入口\n\n${item.runtimeName ? `\`${item.runtimeName}\`` : '当前没有运行时入口。'}\n\n## 来源与版本\n\n- 来源：${item.source.label}\n- 版本：${item.source.version ?? '未单独提供'}\n- 来源记录：${item.source.reference ?? item.id}\n\n## 当前状态\n\n- 环境：${toolAvailabilityLabel[item.availability.state]}\n- 当前成员：${item.configured ? '已配置' : '未配置'}\n${item.lifecycle ? `- 版本状态：${toolLifecycleLabel(item.lifecycle)}\n` : ''}${item.reason ? `\n${item.reason}\n` : ''}`
}

export function expertConfigurationMarkdown(configuration: ExpertConfiguration): string {
  const list = (values: readonly string[]) =>
    values.map((value) => `- ${value}`).join('\n') || '未单独指定。'
  return `# ${configuration.displayName}\n\n${configuration.specialty}\n\n## 适合哪些任务\n\n${list(configuration.situations)}\n\n## 负责的工作\n\n${list(configuration.responsibilities)}\n\n## 工作方法\n\n${configuration.methods.map((method) => `### ${method.title}\n\n${method.instructions}\n\n${method.sourceUris.length ? `依据：${method.sourceUris.join('、')}` : ''}`).join('\n\n') || '未单独指定。'}\n\n## 交接与协作\n\n${list(configuration.collaboration)}\n\n## 工作约束\n\n${list(configuration.constraints)}\n\n## 技能与工具\n\n- 技能：${configuration.role.skills?.join('、') || '未选择技能'}\n- 工具引用：${configuration.toolRefs.join('、') || '未选择工具引用'}\n- 基础席位：${configuration.baseRole}\n\n## 资源依据\n\n${configuration.sources.map((source) => `### ${source.title}\n\n${source.excerpt}\n\n${source.uri}`).join('\n\n') || '未提供独立资源依据。'}`
}
