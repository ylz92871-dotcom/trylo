import {
  Accessibility,
  Box,
  Braces,
  ClipboardCheck,
  FileText,
  Globe,
  Hammer,
  ScanSearch,
  ShieldCheck,
  Table2,
  UserRound,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ToolLibraryItem } from '../../tool-library/client'
import type { ExpertConfiguration } from '../../../../new trylo cli/src/internal/subagent/experts/contracts'
import './library-object-icon.css'

/** These are category hints from the object's own metadata, never external logos or status. */
function toolIcon(item: ToolLibraryItem): LucideIcon {
  const capabilities = [item.runtimeName ?? '', ...item.capabilities].join(' ').toLowerCase()
  if (/browser|网页|浏览器/.test(capabilities)) return Globe
  if (/json/.test(capabilities)) return Braces
  if (/\bcad\b|零件|装配/.test(capabilities)) return Box
  if (/spreadsheet|csv|表格|金额|字段/.test(capabilities)) return Table2
  if (/read_file|write_file|file|文件/.test(capabilities)) return FileText
  return Wrench
}

function expertIcon(configuration: ExpertConfiguration): LucideIcon {
  const specialty = [configuration.specialty, ...configuration.situations].join(' ').toLowerCase()
  if (/accessib|无障碍|可访问性|键盘导航|焦点恢复/.test(specialty)) return Accessibility
  if (/\bcad\b|零件|装配/.test(specialty)) return Box
  if (/spreadsheet|报表|表格|结构化|金额|账单/.test(specialty)) return ClipboardCheck
  if (/research|资料|来源|核查|一手|文献|检索/.test(specialty)) return ScanSearch
  const roles: Readonly<Record<ExpertConfiguration['baseRole'], LucideIcon>> = {
    person: UserRound,
    architect: Workflow,
    worker: Hammer,
    reviewer: ClipboardCheck,
    verifier: ShieldCheck,
    'cad-planner': Box,
    'cad-verifier': Box,
  }
  return roles[configuration.baseRole] ?? UserRound
}

function ObjectIcon({ icon: Icon, detail }: { icon: LucideIcon; detail?: boolean }) {
  return (
    <span className="library-object-icon" data-detail={detail || undefined} aria-hidden="true">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </span>
  )
}

export function ToolObjectIcon({ item, detail }: { item: ToolLibraryItem; detail?: boolean }) {
  return <ObjectIcon icon={toolIcon(item)} detail={detail} />
}

export function ExpertObjectIcon({
  configuration,
  detail,
}: {
  configuration: ExpertConfiguration
  detail?: boolean
}) {
  return <ObjectIcon icon={expertIcon(configuration)} detail={detail} />
}
