import { ACTIVE_POLICY_TAG } from './types';
import { TEAM_ACCESS_TAG } from './team-access/render-team-access';

export function composeSystemPrompt(
  basePrompt: string | undefined,
  injectionText: string,
  enforced: boolean,
  teamAccessText?: string,
): string {
  const base = (basePrompt ?? '').trim();
  if (!enforced || !injectionText.trim()) {
    // Personal Policy is shadow-only, but the team-access block (protocol
    // + contract JSON) must reach the PA append regardless of Shadow —
    // the CLI extracts the contract from it for seat user prompts
    // (spec §17.4: teamAccessText is constrained by the flag, not by
    // Personal Policy mode).
    if (teamAccessText?.trim()) {
      return [stripInjection(base), teamAccessText].filter(Boolean).join('\n\n').trim();
    }
    return base;
  }
  if (base.includes(`<${ACTIVE_POLICY_TAG}>`)) {
    const withoutOld = stripInjection(base);
    return [withoutOld, injectionText, teamAccessText].filter(Boolean).join('\n\n').trim();
  }
  return [base, injectionText, teamAccessText].filter(Boolean).join('\n\n').trim();
}

export function stripInjection(prompt: string): string {
  let out = prompt;
  const start = out.indexOf(`<${ACTIVE_POLICY_TAG}>`);
  if (start >= 0) {
    const endTag = `</${ACTIVE_POLICY_TAG}>`;
    const end = out.indexOf(endTag, start);
    out = end < 0
      ? out.slice(0, start)
      : `${out.slice(0, start)}${out.slice(end + endTag.length)}`;
  }
  // The team-access block is PA-context only; stripInjection is used when
  // recomposing, so remove it here too (best-effort, tag-scoped).
  const teamStart = out.indexOf(`<${TEAM_ACCESS_TAG}>`);
  if (teamStart >= 0) {
    const teamEndTag = `</${TEAM_ACCESS_TAG}>`;
    const teamEnd = out.indexOf(teamEndTag, teamStart);
    out = teamEnd < 0
      ? out.slice(0, teamStart)
      : `${out.slice(0, teamStart)}${out.slice(teamEnd + teamEndTag.length)}`;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function injectionWasApplied(prompt: string | undefined): boolean {
  return Boolean(prompt && prompt.includes(`<${ACTIVE_POLICY_TAG}>`));
}

/** Removes ONLY the Personal Policy block; team access (contract is a
 *  task spec, not personalization) survives — used on impact-baseline
 *  resume (spec §7.3). */
export function stripPolicyInjection(prompt: string): string {
  const start = prompt.indexOf(`<${ACTIVE_POLICY_TAG}>`);
  if (start < 0) return prompt;
  const endTag = `</${ACTIVE_POLICY_TAG}>`;
  const end = prompt.indexOf(endTag, start);
  const out = end < 0
    ? prompt.slice(0, start)
    : `${prompt.slice(0, start)}${prompt.slice(end + endTag.length)}`;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
