import type { EvidenceEventType, PolicyDimension } from './types';

/** User-facing names for policy dimensions. Internal enums stay in the store. */
export const DIMENSION_LABEL: Readonly<Record<PolicyDimension, string>> = {
  agent_autonomy: '自主程度',
  planning_direct_execution: '计划与直接执行',
  engineering_depth: '工程深度',
  architecture_refactor: '结构与复用',
  verification_audit: '验证与审核',
  git_change_management: '提交节奏',
  cost_time_quality: '成本与质量',
  interaction_interruption: '打断与确认',
  reporting_information_density: '过程怎么说',
  tool_workflow: '电脑和浏览器',
  product_ux_acceptance: '成品观感',
  domain_capability_feedback_reliability: '能力反馈',
  engineering_language_semantics: '你的工程用语',
  security_data_integrity: '安全与数据底线',
  work_artifact_workflow: '产物怎么交付',
};

export function dimensionLabel(dimension: PolicyDimension): string {
  return DIMENSION_LABEL[dimension] ?? dimension;
}

/** User-facing labels covering every `EvidenceEventType`. PR-4 (§4.2). */
export const EVENT_TYPE_LABEL: Readonly<Record<EvidenceEventType, string>> = {
  explicit_statement: '明确说法',
  correction: '纠正',
  choice: '选择',
  approval: '批准',
  rejection: '拒绝',
  override: '覆盖',
  intervention: '干预',
  rollback: '回滚',
  manual_edit: '手工修改',
  outcome_feedback: '结果反馈',
  cognition_answer: '认知回答',
  cognition_confirmation: '认知确认',
  authoritative_correction: '权威纠正',
};

export function eventTypeLabel(type: EvidenceEventType): string {
  return EVENT_TYPE_LABEL[type] ?? type;
}
