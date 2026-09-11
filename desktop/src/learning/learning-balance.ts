// Two learning planes share one Agent loop. They do not share stores,
// proposals, or the auto-injected prompt slot.
//
//   Task plane (Hermes): HOW to do the work
//     Skills, session search, MEMORY.md environment facts
//     Write path: staged propose → user apply
//     Read path: MCP tools on demand (not every-turn auto inject)
//
//   User plane (Trylo User Learning): HOW to collaborate with this person
//     Evidence → Conclusion → User Model → Engineering Policy
//     Write path: JSON snapshot, Cognition/Impact in the chat stream
//     Read path: short Active Policy via --append-system-prompt (Enforced only)
//
// Precedence when they disagree:
//   safety / data integrity > current explicit instruction >
//   User Learning Active Policy > Hermes Skill procedure > Hermes MEMORY facts

export type LearningPlane = 'task' | 'user' | 'neither';

export const PROMPT_LAYER_ORDER = [
  'safety_floor',
  'explicit_task_instruction',
  'user_learning_active_policy',
  'hermes_skill_on_demand',
  'hermes_memory_on_demand',
] as const;

const USER_PLANE_RE = /审核|验证|计划|直接做|打断|汇报|偏好|理解错|最终验证|重复审核|作用域|只要结论|太花|重做|自己点|浏览器|先看结构/i;
const TASK_PLANE_RE = /命令|workflow|步骤|脚本|skill|复用这套|下次同样|部署|pipeline/i;

export function classifyLearningSignal(text: string): LearningPlane {
  const value = text.trim();
  if (!value) return 'neither';
  const user = USER_PLANE_RE.test(value);
  const task = TASK_PLANE_RE.test(value);
  if (user && !task) return 'user';
  if (task && !user) return 'task';
  if (user && task) return 'user';
  return 'neither';
}

export interface PostTerminalPlan {
  readonly closeUserTrace: boolean;
  readonly enrichUserLearning: boolean;
  readonly hermesReview: boolean;
  readonly reasonCode:
    | 'both'
    | 'user_only_cognition'
    | 'user_only_interrupt'
    | 'hermes_only'
    | 'skip_failed'
    | 'disabled';
}

export function planPostTerminal(input: {
  readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly userLearningEnabled: boolean;
  readonly hermesEnabled: boolean;
  readonly cognitionTurn: boolean;
  readonly pendingUserInterrupt: boolean;
}): PostTerminalPlan {
  const userOn = input.userLearningEnabled;
  const hermesOn = input.hermesEnabled;
  if (!userOn && !hermesOn) {
    return { closeUserTrace: false, enrichUserLearning: false, hermesReview: false, reasonCode: 'disabled' };
  }
  if (input.cognitionTurn) {
    return {
      closeUserTrace: false,
      enrichUserLearning: false,
      hermesReview: false,
      reasonCode: 'user_only_cognition',
    };
  }
  const closeUserTrace = userOn;
  const enrichUserLearning = userOn && (input.outcome === 'completed' || input.outcome === 'cancelled');
  if (input.pendingUserInterrupt) {
    return {
      closeUserTrace,
      enrichUserLearning,
      hermesReview: false,
      reasonCode: 'user_only_interrupt',
    };
  }
  if (input.outcome !== 'completed') {
    return {
      closeUserTrace,
      enrichUserLearning,
      hermesReview: false,
      reasonCode: 'skip_failed',
    };
  }
  if (userOn && hermesOn) {
    return { closeUserTrace: true, enrichUserLearning: true, hermesReview: true, reasonCode: 'both' };
  }
  if (userOn) {
    return { closeUserTrace: true, enrichUserLearning: true, hermesReview: false, reasonCode: 'disabled' };
  }
  return { closeUserTrace: false, enrichUserLearning: false, hermesReview: true, reasonCode: 'hermes_only' };
}
