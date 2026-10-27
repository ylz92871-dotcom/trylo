import type { ReactElement } from 'react';
import type { TeamRoleId } from '../team-types';

const paths: Record<TeamRoleId | 'personal', string> = {
  personal: 'M12 2 20 7 17 12 12 8 7 12 4 7z M7 12l5 10 5-10-5 4z',
  person: 'M12 2 20 7 17 12 12 8 7 12 4 7z M7 12l5 10 5-10-5 4z',
  architect: 'M12 2 22 20H2z M12 7 7 17h10z',
  worker: 'M8 3 2 12l6 9 3-4-4-5 4-5z M16 3l6 9-6 9-3-4 4-5-4-5z',
  reviewer: 'M12 2 21 6v7l-9 9-9-9V6z M12 6 7 9v3l5 5 5-5V9z',
  verifier: 'M12 2c6 0 10 4 10 10-5-4-9-3-10 0 0-6-4-8-10-7 3-2 6-3 10-3z M22 12c0 6-4 10-10 10 4-5 3-9 0-10 6 0 8-4 7-10 2 3 3 6 3 10z M12 22C6 22 2 18 2 12c5 4 9 3 10 0 0 6 4 8 10 7-3 2-6 3-10 3z',
  'cad-planner': 'M3 10 10 3l2 6-6 6z M14 3l7 7-6 2-6-6z M21 14l-7 7-2-6 6-6z M10 21l-7-7 6-2 6 6z',
  'cad-verifier': 'M12 2 22 8v8l-10 6L2 16V8z M12 6 6 10v4l6 4 6-4v-4z',
};

export function TeamMark({ role, size = 24 }: { readonly role: TeamRoleId | 'personal'; readonly size?: number }): ReactElement {
  return <svg className="team-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={paths[role]} fill="currentColor" fillRule="evenodd" /></svg>;
}
