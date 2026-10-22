import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import type { SubagentMessage } from './types';
import '../../styles/components/agent-avatar.css';

// Flat vector versions of the approved Trylo folded family (V7–V10).
// Identity is independent of role, display name, status and stream updates.
const FOLDS = [
  ['M36 4C42 13 33 26 39 35C49 30 58 43 59 55C48 61 31 48 19 45C11 43 5 51 3 47C4 38 17 26 23 31C34 30 22 17 36 4Z', 'M36 4C22 8 13 22 23 31L39 48C25 41 16 37 3 47C4 38 17 26 23 31C31 29 21 18 36 4ZM40 35C48 30 57 43 59 55C48 60 39 46 40 35Z', 'M36 4C28 22 25 30 39 35C30 35 25 29 28 20ZM23 32L45 54C35 50 32 42 23 32Z'],
  ['M8 15C26 1 46 5 55 19C62 32 59 46 48 52C36 58 20 63 10 48C0 36 2 25 8 15Z', 'M8 15C23 1 46 5 55 19C51 28 44 31 37 34C43 22 30 20 8 15ZM5 30C9 22 29 23 33 27C37 30 23 42 22 57C11 55 1 41 5 30ZM35 47C46 44 52 34 57 23C63 38 58 51 48 52C39 55 31 54 28 52Z', 'M13 16C34 19 44 22 37 34C31 43 26 49 33 51C20 52 29 39 34 30C38 24 24 20 13 16Z'],
  ['M31 3C40 10 43 21 43 31C52 21 60 38 62 52C55 58 46 46 38 54C29 63 21 47 12 52C3 56 1 55 3 46C7 29 15 23 21 31C21 18 24 9 31 3Z', 'M31 3C39 8 43 21 41 27L32 44L22 27C22 16 25 8 31 3ZM18 29C24 33 29 43 24 48C16 52 10 50 3 54C0 49 9 25 18 29ZM47 29C54 24 61 43 62 52C56 57 47 48 38 53C36 43 41 32 47 29Z', 'M35 40C31 48 33 54 38 54C33 58 28 49 35 40Z'],
  ['M3 30C9 20 26 8 38 8C44 7 48 20 50 29C60 28 64 29 62 34C57 44 45 53 34 49C22 55 8 44 3 36Z', 'M3 30C9 20 26 8 38 8C44 7 46 20 40 23C26 25 17 24 8 39C2 37 1 34 3 30ZM12 37C18 24 26 27 30 33L35 48C27 55 17 46 12 37ZM34 30C46 28 57 28 62 31C64 35 50 49 43 49C37 44 36 38 34 30Z', 'M8 39C18 24 26 24 40 28L47 30C29 34 25 18 8 39Z'],
  ['M5 13C20 0 35 6 37 17C41 28 32 34 42 35C51 38 59 47 58 56C52 61 42 49 32 53C18 60 7 62 4 53C19 40 15 27 5 13Z', 'M5 13C18 3 29 3 30 16C29 31 17 47 4 53C18 37 14 26 5 16ZM37 36C45 28 59 44 58 56C53 62 43 49 32 53C23 58 12 60 6 56C22 56 27 43 37 36Z', 'M27 5C46 16 28 40 9 55C25 50 46 21 31 8Z'],
  ['M6 16C15 3 40 0 55 14C66 28 45 48 35 59C26 65 11 45 6 33C3 27 2 23 6 16Z', 'M6 16C16 2 42 1 55 14C62 21 45 32 36 35C42 24 22 20 6 16ZM5 21C18 19 30 26 28 39L30 59C19 55 4 34 5 21ZM34 51C42 46 50 36 58 23C58 37 43 52 35 59C32 58 32 55 34 51Z', 'M10 17C33 20 43 24 36 35C28 46 29 52 34 51C24 57 25 48 31 37C39 26 23 22 10 17Z'],
  ['M31 3C40 11 43 24 44 31C53 25 64 19 61 31C60 48 50 60 33 59C16 61 6 48 3 31C0 20 14 27 21 31C22 19 25 10 31 3Z', 'M31 3C39 10 43 22 42 29L32 46L22 29C21 21 26 9 31 3ZM3 24C16 28 27 39 27 58C15 61 6 44 3 31ZM61 24C61 41 52 61 38 58C38 39 49 29 61 24Z', 'M20 33C27 40 29 50 27 58C24 45 24 40 20 33ZM43 36C38 45 38 53 38 58C34 54 36 43 43 36Z'],
  ['M4 43C10 30 23 35 24 24C24 18 49 6 61 5C65 8 47 13 42 27C40 36 48 39 48 50C48 63 31 51 19 47C10 43 2 49 4 43Z', 'M24 24C25 17 48 7 61 5C63 8 48 13 41 22C35 31 30 30 24 24ZM4 43C10 30 23 34 30 39L44 55C31 49 22 39 4 46ZM45 40C49 38 53 58 47 59C39 58 37 43 45 40Z', 'M43 18C35 33 34 35 44 55C30 39 32 33 43 18Z'],
  ['M31 4C46 1 56 17 57 31C65 48 49 60 36 58C19 64 3 49 5 35C1 26 17 9 31 4ZM31 21C26 25 23 34 23 37C29 41 36 40 40 37C39 30 35 25 31 21Z', 'M12 19C17 5 37 1 47 9C57 17 54 27 49 37C46 43 43 26 35 19C28 12 19 12 12 19ZM7 30C12 23 22 18 28 19C22 27 13 40 17 49C20 55 23 57 28 59C12 58 0 43 7 30ZM24 43C35 45 50 40 57 31C65 46 50 61 36 58C30 58 24 51 24 43Z', 'M10 23C26 15 35 14 41 23C46 30 48 38 49 37C41 43 29 47 20 43L22 39C32 44 40 40 43 37C41 27 35 17 29 20C26 23 23 31 20 38C20 31 25 22 27 21C20 20 13 22 10 23Z'],
  ['M3 46C7 33 20 17 29 10C39 2 48 18 61 43C67 56 53 55 45 52C31 37 25 44 13 52C5 56 0 53 3 46Z', 'M10 35C19 23 25 14 30 10C39 3 50 20 61 43C67 56 54 55 46 52C42 38 37 26 26 25C18 24 14 29 10 35ZM3 46C8 36 18 27 24 28C31 33 19 48 13 52C6 56 0 53 3 46Z', 'M10 35C25 17 42 25 46 43C36 29 27 23 10 35Z'],
  ['M35 3C44 0 44 21 39 28C52 22 61 29 60 44C60 59 44 61 29 59C15 60 7 45 7 36C7 24 17 29 20 30C22 21 28 6 35 3Z', 'M35 3C44 0 44 21 39 28C32 31 35 41 36 46C25 30 25 20 35 3ZM7 33C9 22 27 32 29 44C32 50 30 57 29 59C14 62 5 45 7 33ZM43 29C60 21 65 43 56 52C51 58 43 59 34 59C43 49 42 39 43 29Z', 'M28 14C23 31 43 37 36 51C34 56 32 59 29 59C41 43 21 30 28 14Z'],
  ['M27 4C39 1 48 12 53 21C63 31 61 45 50 53C41 61 25 63 15 54C1 48 1 33 9 26C4 17 17 7 27 4Z', 'M9 20C13 10 26 1 34 5C47 8 48 20 45 28C40 32 40 22 32 22C23 19 15 20 9 20ZM5 35C6 26 20 21 25 25C21 38 20 47 32 58C20 64 1 47 5 35ZM32 44C43 43 50 34 54 23C65 34 60 49 50 53C40 56 32 54 32 44Z', 'M13 20C31 18 39 20 42 27C43 31 39 29 38 27C34 19 26 23 26 32C25 40 29 45 32 44C22 51 19 34 23 28C27 21 21 23 13 20Z'],
] as const;

export function agentAvatarIndex(agent: Pick<SubagentMessage, 'id' | 'subagentId'>): number {
  let hash = 2166136261;
  for (const char of agent.subagentId ?? agent.id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0) % FOLDS.length;
}

const AvatarIdentities = createContext<ReadonlyMap<string, number>>(new Map());

/** Resolve hash collisions within the first twelve members, shared by both panes. */
export function AgentAvatarScope({ identities, children }: { readonly identities: readonly string[]; readonly children: ReactNode }): ReactElement {
  const signature = JSON.stringify(identities);
  const assignments = useMemo(() => {
    const result = new Map<string, number>();
    for (const id of JSON.parse(signature) as string[]) {
      if (result.has(id)) continue;
      let index = agentAvatarIndex({ id });
      if (result.size < FOLDS.length) {
        const used = new Set(result.values());
        while (used.has(index)) index = (index + 1) % FOLDS.length;
      }
      result.set(id, index);
    }
    return result;
  }, [signature]);
  return <AvatarIdentities.Provider value={assignments}>{children}</AvatarIdentities.Provider>;
}

export function AgentAvatar({ agent, size = 24 }: {
  readonly agent: Pick<SubagentMessage, 'id' | 'subagentId'>;
  readonly size?: number;
}): ReactElement {
  const assignments = useContext(AvatarIdentities);
  const variant = assignments.get(agent.subagentId ?? agent.id) ?? agentAvatarIndex(agent);
  const [base, face, seam] = FOLDS[variant]!;
  return <svg className="agent-avatar" width={size} height={size} viewBox="0 0 64 64"
    aria-hidden="true" focusable="false" data-avatar={variant}>
    <path className="agent-avatar__ink" d={base} fillRule="evenodd" />
    <path className="agent-avatar__fold" d={face} />
    <path className="agent-avatar__seam" d={seam} />
  </svg>;
}
