import { newId } from './ids';
import type {
  EvidenceRecord,
  PersonalizationEligibilityDecision,
  UserDecisionTrace,
} from './types';

const AUTH_RE = /权限|授权|凭证|密码|密钥|登录|账号|支付|permission|credential|secret|token/i;
const SAFETY_RE = /不要编造|真实性|来源|引用|丢数据|数据完整|安全底线|不可逆|必须验证|最终验证|备份|回滚|security|integrity/i;
const SESSION_RE = /这次|当前任务|这个任务|临时|仅本次|先把这|现在先/;
const PERSIST_RE = /以后|今后|每次|一直|默认|项目里|这个项目|长期|通常|习惯/;
const REPORT_OBJECT_RE = /报告|周报|汇报|总结|交付说明|report/i;
const REPORT_BEHAVIOR_RE = /结论优先|先说结论|只要结论|背景优先|先说背景|依据展开|详细依据|少说过程|不要过程/;
const ARTIFACT_OBJECT_RE = /方案|文稿|文档|PPT|幻灯片|提案|草稿|artifact|draft/i;
const ARTIFACT_BEHAVIOR_RE = /先(?:看|给|出)?结构|结构优先|先(?:出|给|写)?完整(?:草稿|一版)|先出一版|先草稿/;
const CLEAR_OBJECT_RE = /审核|Review|计划|实现|报告|周报|汇报|方案|文稿|文档|工具|界面|UI|代码|任务|交付/i;
const CLEAR_BEHAVIOR_RE = /不要|避免|减少|优先|先|直接|保留|展开|简短|详细|克制/;

function rawText(evidence: EvidenceRecord): string {
  return `${evidence.rawObservation.text} ${evidence.inference.claim}`.trim();
}

export function classifyPersonalizationEligibility(input: {
  readonly evidence: EvidenceRecord;
  readonly trace?: UserDecisionTrace;
  readonly now: number;
}): PersonalizationEligibilityDecision {
  const text = rawText(input.evidence);
  const supportedPreference = (
    (REPORT_OBJECT_RE.test(text) && REPORT_BEHAVIOR_RE.test(text))
    || (ARTIFACT_OBJECT_RE.test(text) && ARTIFACT_BEHAVIOR_RE.test(text))
  );
  const groundedCollaborationPreference = (
    (input.evidence.signalKind === 'collaboration_preference'
      || input.evidence.signalKind === 'cognition_answer')
    && CLEAR_OBJECT_RE.test(text)
    && CLEAR_BEHAVIOR_RE.test(text)
  );
  let classification: PersonalizationEligibilityDecision['classification'] = 'insufficient_information';
  let rationale = '没有足够信息证明这是可长期复用的协作偏好。';

  if (AUTH_RE.test(text)) {
    classification = 'authorization_or_permission';
    rationale = '该信号涉及权限、凭证或授权，必须由安全与授权规则处理。';
  } else if (SESSION_RE.test(text) && !PERSIST_RE.test(text)) {
    classification = 'session_instruction';
    rationale = '该信号明确限制在当前任务或本次协作中。';
  } else if (supportedPreference) {
    classification = 'personalization_candidate';
    rationale = '该信号在多个合格做法之间表达了明确的交付行为偏好。';
  } else if (groundedCollaborationPreference) {
    classification = 'personalization_candidate';
    rationale = SAFETY_RE.test(text)
      ? '复合信号中存在明确协作偏好；其中安全底线仍独立保持最高优先级。'
      : '用户来源信号同时包含明确对象和可执行行为。';
  } else if (SAFETY_RE.test(text)) {
    classification = 'safety_or_integrity_requirement';
    rationale = '该信号属于所有用户都应获得的安全、真实性或数据完整性底线。';
  } else if (input.evidence.signalKind === 'correction' || input.evidence.origin.eventType === 'correction') {
    if (PERSIST_RE.test(text) && CLEAR_OBJECT_RE.test(text) && CLEAR_BEHAVIOR_RE.test(text)) {
      classification = 'personalization_candidate';
      rationale = '纠正包含持续范围，且存在多个同样合格的协作做法。';
    } else {
      classification = 'general_quality_defect';
      rationale = '该纠正更可能是结果质量问题，不能默认解释为个人偏好。';
    }
  }

  return {
    id: newId('elig', input.now),
    sourceEvidenceIds: [input.evidence.id],
    classification,
    rationale,
    alternativeExplanations: classification === 'personalization_candidate'
      ? ['可能只适用于当前项目', '可能由本次交付受众或阶段造成']
      : [],
    createdAt: input.now,
  };
}
