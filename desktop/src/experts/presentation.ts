import type {
  ExpertBaseRole,
  ExpertRequestState,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'

export const EXPERT_ROLE_LABELS: Readonly<Record<ExpertBaseRole, string>> = {
  person: '用户代表',
  architect: '架构',
  worker: '实施',
  reviewer: '审查',
  verifier: '验收',
  'cad-planner': 'CAD 规划',
  'cad-verifier': 'CAD 验收',
}
export const EXPERT_REQUEST_LABELS: Readonly<Record<ExpertRequestState, string>> = {
  awaiting_creation: '等待创建授权',
  authorized: '已获创建授权',
  awaiting_retention: '待审核入库',
  revision_requested: '等待按意见修改',
  saved: '已长期保存',
  temporary: '临时（限原授权任务）',
  rejected: '未同意创建',
}
