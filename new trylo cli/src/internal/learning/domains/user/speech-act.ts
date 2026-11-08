export const USER_SPEECH_ACTS = [
  "future_directive",
  "correction",
  "confirm",
  "withdraw",
  "not_explicit",
] as const;

export type UserSpeechAct = (typeof USER_SPEECH_ACTS)[number];

const FUTURE = /以后(都)?这样|以后都这样|以后都这么做|from now on|always do this|keep doing that from now/i;
const CORRECTION = /不要再|别再|stop doing|\bdon't\b|do not do/i;
const CONFIRM = /就这样|keep doing that|yes exactly|perfect, keep/i;
const WITHDRAW = /撤回|取消这条|forget that|don't remember that|撤销这条/i;
const GLOBAL = /所有项目|所有任务都|everywhere|user-global|全局以后都/i;
const PERMISSION = /跳过审批|skip approval|bypass approval|允许网络|allow network|grant permission|不要审批|skipApproval|allowNetwork/i;

export function detectSpeechAct(text: string): UserSpeechAct {
  if (WITHDRAW.test(text)) {
    return "withdraw";
  }

  if (FUTURE.test(text)) {
    return "future_directive";
  }

  if (CORRECTION.test(text)) {
    return "correction";
  }

  if (CONFIRM.test(text)) {
    return "confirm";
  }

  return "not_explicit";
}

export function detectsExplicitGlobal(text: string): boolean {
  return GLOBAL.test(text);
}

export function detectsPermissionLanguage(text: string): boolean {
  return PERMISSION.test(text);
}

export function residualPreference(text: string): string {
  return text
    .replace(PERMISSION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPermissionOnly(text: string): boolean {
  const leftover = residualPreference(text)
    .replace(/以后(都)?/g, " ")
    .replace(/请|帮我|务必/g, " ")
    .replace(/[，,。!！]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return detectsPermissionLanguage(text) && leftover.length === 0;
}
