import type { CognitionPromptMessage, LearningImpactMessage } from '../components/chat/types';
import type { CognitionSession, PolicyDecision } from './types';

const ACTION_LABEL: Record<string, string> = {
  'require:plan_first': '先计划再改',
  'require:final_verification': '保留最终验证',
  'prefer:direct_execution': '低风险直接执行',
  'avoid:duplicate_review': '减少重复审核',
  'skip_verification': '跳过验证',
  'skip_tests': '跳过测试',
  'weaken_security': '放宽安全',
  'direct_execution': '直接执行',
  'duplicate_review': '重复审核',
};

export function formatPolicyAction(action: string): string {
  return ACTION_LABEL[action] ?? ACTION_LABEL[action.split(':')[1] ?? ''] ?? action.replace(/^[^:]+:/, '');
}

export function cognitionPromptMessage(
  session: CognitionSession,
  status: CognitionPromptMessage['status'] = 'pending',
): CognitionPromptMessage {
  const question = session.questions[session.questions.length - 1] ?? session.questions[0];
  const lastAnswer = session.answers[session.answers.length - 1]?.text;
  const prompt = session.pendingConfirmScope
    ? `你刚才说「${(lastAnswer ?? '').slice(0, 40)}」。如果这意味着核心路径或账号数据也放松，你还按同一原则吗？`
    : question?.prompt ?? '';
  return {
    id: `cognition:${session.id}:${session.answers.length}`,
    kind: 'cognition_prompt',
    role: 'system',
    createdAt: session.createdAt,
    sessionId: session.id,
    prompt,
    options: session.pendingConfirmScope ? ['是，同样适用', '不，核心路径保留严格基线'] : question?.options ?? [],
    dimension: session.dimension,
    status,
  };
}

export function learningImpactMessage(decision: PolicyDecision): LearningImpactMessage | null {
  const check = decision.impactCheck;
  if (!check?.interruptUser && !decision.clarificationRequired) return null;
  return {
    id: `impact:${decision.id}`,
    kind: 'learning_impact',
    role: 'system',
    createdAt: decision.createdAt,
    reason: check?.reason
      ?? decision.clarificationQuestion
      ?? 'personalized policy would change an engineering control',
    baseline: (check?.baselineActions ?? []).map(formatPolicyAction),
    personalized: decision.resolvedActions.map(formatPolicyAction),
    status: 'pending',
  };
}

// Foundation spec §7.2 / §8.5: the Person conversation NEVER renders a
// team-spawn card. The old `teamSpawnMessage` (ask_user/refuse card) is
// deleted — refuse still reaches the user through a plain `notice`
// (the existing `team-blocked-` path in App.tsx).
