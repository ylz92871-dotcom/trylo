import type { ReactElement } from 'react';
import { Logo } from '../../../components/brand/Logo';
import { AgentAvatar } from '../../../components/chat/AgentAvatar';
import type { TeamRoleId } from '../team-types';

export function TeamMark({ role, identity, size = 24 }: {
  readonly role: TeamRoleId | 'personal'; readonly identity?: string; readonly size?: number;
}): ReactElement {
  return <span className={`team-mark${role === 'personal' ? ' team-mark--brand' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    {role === 'personal' ? <Logo size={Math.round(size * 2.15)} decorative variant="solid" tone="ink" />
      : <AgentAvatar agent={{ id: identity ?? role }} size={size} />}
  </span>;
}
