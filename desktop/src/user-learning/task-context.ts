import type { ProductSurface, RiskLevel, TaskContext } from './types';

const CORE_RE = /runtime|persist|migrat|schema|auth|token|security|database|sqlite|sql\b|memory.?store|session.?json|integrity|crypto|permission/i;
const HIGH_RE = /production|deploy|rollback|irreversible|destructive|drop table|rm -rf|format disk|secret|credential/i;
const LOW_RE = /button|margin|padding|copy|文案|css|color|icon|typo|label|placeholder|readme|comment/i;
const PLAN_RE = /plan first|先规划|先讲清|先设计|先 plan/i;

const WORK_HIGH_RE = /账号|支付|密码|登录|转账|删除全部|不可逆/i;
const WORK_DELIVERABLE_RE = /ppt|pptx|幻灯|报告|周报|文档|docx|xlsx|表格|教案/i;
const WORK_BROWSER_RE = /浏览器|网页|填表|打开网站/i;
const WORK_DESKTOP_RE = /电脑|桌面|截屏|点击|键鼠|屏幕/i;

export function classifyTaskContext(input: {
  readonly prompt: string;
  readonly product: ProductSurface;
  readonly explicitInstruction?: string;
}): TaskContext {
  const prompt = input.prompt.trim();
  const combined = `${prompt}\n${input.explicitInstruction ?? ''}`;
  if (input.product === 'work') {
    const high = WORK_HIGH_RE.test(combined);
    const changeType = WORK_BROWSER_RE.test(combined)
      ? 'browser'
      : WORK_DESKTOP_RE.test(combined)
        ? 'desktop_control'
        : WORK_DELIVERABLE_RE.test(combined)
          ? 'deliverable'
          : 'work_task';
    return {
      product: 'work',
      taskType: changeType,
      risk: high ? 'high' : 'medium',
      corePath: high,
      reversible: !high,
      components: high ? ['sensitive'] : [changeType],
      changeType,
      explicitInstruction: input.explicitInstruction ?? '',
      prompt,
    };
  }
  const corePath = CORE_RE.test(combined);
  const high = HIGH_RE.test(combined) || corePath && /migrat|schema|persist|auth/i.test(combined);
  const low = !corePath && LOW_RE.test(combined);
  let risk: RiskLevel = 'medium';
  if (high) risk = 'high';
  else if (low) risk = 'low';

  let changeType = 'implementation';
  if (LOW_RE.test(combined)) changeType = 'ui';
  else if (/bug|fix|修/i.test(combined)) changeType = 'bugfix';
  else if (/migrat|schema/i.test(combined)) changeType = 'migration';
  else if (/refactor|重构/i.test(combined)) changeType = 'refactor';
  else if (corePath) changeType = 'core_runtime';

  const reversible = risk !== 'high' && !/migrat|schema|persist/i.test(combined);

  return {
    product: input.product,
    taskType: changeType,
    risk,
    corePath,
    reversible,
    components: corePath ? ['core'] : low ? ['frontend'] : [],
    changeType,
    explicitInstruction: input.explicitInstruction ?? '',
    prompt,
  };
}

export function taskContextSignature(ctx: TaskContext): string {
  return [
    ctx.product,
    ctx.taskType,
    ctx.risk,
    ctx.corePath ? 'core' : 'n',
    ctx.reversible ? 'rev' : 'irrev',
    ctx.changeType,
    ctx.components.join(','),
  ].join('|');
}

export function promptLooksLikePlanRequest(prompt: string): boolean {
  return PLAN_RE.test(prompt);
}
