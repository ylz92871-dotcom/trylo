/**
 * User Cognition Skill — Cognition Map.
 *
 * The map answers "what engineering dimensions should Trylo try to learn
 * about this user". The current P0 keeps it coarse-grained (one question
 * per high-value dimension) per Skill doc §4 / §25.1 — it deliberately
 * does NOT explode into dozens of axes.
 *
 * This file used to live inline in cognition.ts. It is extracted so the
 * Question Selector / Strategy / Answer Resolution / Stop logic can share
 * one source of truth for the dimension set. The five-seat roster in
 * surfaces/ is unrelated; this dimension set is the person-level map.
 */

import type { CognitionQuestion } from '../types';

export const QUESTION_BANK: readonly CognitionQuestion[] = [
  {
    id: 'q_verify_scope',
    dimension: 'verification_audit',
    trigger: 'high_value_gap',
    prompt: '在低风险代码修改里，如果已有自动测试通过，你更希望 Agent 直接完成，还是再增加一次独立代码审核？这一选择是否也适用于数据库迁移和核心运行链路？',
    options: [
      '低风险直接完成；核心路径仍要最终验证',
      '所有任务都再加一轮独立审核',
      '所有任务都跳过额外审核',
    ],
    scopeHint: 'verification vs core path',
  },
  {
    id: 'q_plan_scope',
    dimension: 'planning_direct_execution',
    trigger: 'high_value_gap',
    prompt: '假设现在只是一个不影响核心架构的小功能：你通常希望直接实现，还是先给计划？如果换成 Agent Runtime / 持久化这类核心模块，选择会不同吗？',
    options: [
      '小功能直接做，核心模块先计划',
      '都直接做',
      '都先计划',
    ],
    scopeHint: 'planning vs core path',
  },
  {
    id: 'q_report',
    dimension: 'reporting_information_density',
    trigger: 'high_value_gap',
    prompt: '在执行任务时，你更希望看到完整过程叙述，还是只在关键决策、阻塞、产物和最终结果时更新？',
    options: [
      '只在关键节点更新',
      '希望看到较完整过程',
    ],
    scopeHint: 'reporting density',
  },
  {
    id: 'q_architecture',
    dimension: 'architecture_refactor',
    trigger: 'high_value_gap',
    prompt: '对一个需求已经明确的局部功能，你更希望直接改现有模块，还是先抽新的抽象层？如果换成核心 Runtime / 持久化，选择会不同吗？',
    options: [
      '局部功能复用现有模块；核心路径才允许新抽象',
      '能复用就复用，任何路径都先别抽新层',
      '倾向先把结构做干净再改',
    ],
    scopeHint: 'architecture vs local change',
  },
  {
    id: 'q_git',
    dimension: 'git_change_management',
    trigger: 'high_value_gap',
    prompt: '一组改动什么时候该形成 Git checkpoint？按时间频繁提交，还是等可以独立验证之后再提交？高风险修改前要不要先留恢复点？',
    options: [
      '可独立验证后再提交；高风险前先留恢复点',
      '改一点提交一点',
      '只在任务结束时提交',
    ],
    scopeHint: 'git checkpoint',
  },
  {
    id: 'q_security',
    dimension: 'security_data_integrity',
    trigger: 'high_value_gap',
    prompt: '为了加快普通功能，你是否允许放宽测试、备份或权限检查？数据库迁移和密钥/权限路径呢？',
    options: [
      '任何时候都不能放宽安全、测试与数据完整性',
      '普通 UI 可以少一些检查，迁移和权限路径不行',
    ],
    scopeHint: 'safety floor',
  },
  {
    id: 'q_autonomy',
    dimension: 'agent_autonomy',
    trigger: 'high_value_gap',
    prompt: '低风险可逆任务里，你更希望 Agent 自己做完再汇报，还是关键步骤都先问你？核心架构呢？',
    options: [
      '低风险自己做完；核心路径关键决策先问',
      '尽量先问再做',
      '尽量自己做，少打断',
    ],
    scopeHint: 'autonomy vs interrupt',
  },
  {
    id: 'q_work_artifact',
    dimension: 'work_artifact_workflow',
    trigger: 'high_value_gap',
    prompt: '做 PPT 或报告时，你希望先出一版再改，还是正式材料必须先看结构？',
    options: [
      '普通材料先出一版；对外方案先看结构',
      '都先出一版再改',
      '都先看结构再做',
    ],
    scopeHint: 'work deliverable',
  },
  {
    id: 'q_tool_workflow',
    dimension: 'tool_workflow',
    trigger: 'high_value_gap',
    prompt: '操作电脑或浏览器时，低风险点击你希望我自己做，还是每步先问？账号和登录呢？',
    options: [
      '低风险自己做；账号路径先问',
      '尽量先问再做',
      '尽量自己做',
    ],
    scopeHint: 'desktop and browser',
  },
  {
    id: 'q_product_ux',
    dimension: 'product_ux_acceptance',
    trigger: 'high_value_gap',
    prompt: '成品看起来怎样算过关？干净克制，还是要更正式、更接近对外方案？',
    options: [
      '干净克制就行',
      '对外材料必须正式',
    ],
    scopeHint: 'deliverable look',
  },
];

/** Core-path marker words shared by scope extraction. */
export const CORE_PATH_MARKERS: readonly string[] = [
  '核心',
  '核心路径',
  '核心链路',
  '持久化',
  '数据库迁移',
  '迁移',
  'runtime',
  '主链路',
  '生产',
  '生产级',
  '底层',
] as const;

/** Ordinary / low-risk marker words. */
export const ORDINARY_MARKERS: readonly string[] = [
  '小功能',
  '普通功能',
  '低风险',
  '普通 UI',
  '边缘',
  '局部功能',
] as const;