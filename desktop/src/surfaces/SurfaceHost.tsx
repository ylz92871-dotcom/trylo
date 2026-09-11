import type { ReactElement, ReactNode } from 'react';
import { TeamSurface } from './team/TeamSurface';
import type { CollaborationSurface } from './types';
import type { TeamRun } from './team/team-types';
import type { TeamProfile } from './team/team-profile-types';
import type { ModelChoice } from './team/composer/composer-store';

export interface SurfaceHostProps {
  readonly collaborationSurface: CollaborationSurface;
  /** The current Person (Code/Work) view. Pass the existing ChatPanel
   *  as `children` so the Person surface stays byte-identical to today. */
  readonly personView: ReactNode;
  /** The TeamRun attached to the current Person conversation, or null
   *  if there isn't one yet. */
  readonly teamRun: TeamRun | null;
  /** `teamAccessEnabled && teamComposerEnabled` (Foundation spec §9.4). */
  readonly composerLive?: boolean;
  readonly composerDisabledReason?: string;
  /** Builtin templates for the current TopLevelMode (App derives them
   *  from user-learning — surfaces cannot import it). */
  readonly templateProfiles?: readonly TeamProfile[];
  readonly customProfiles?: readonly TeamProfile[];
  readonly modelChoices?: readonly ModelChoice[];
  /** PR-7 wires the launch; PR-8 wires the suggest seeding. */
  readonly onStartTeam?: (goal: string) => void | Promise<void>;
  readonly onSaveProfileAs?: (name: string) => void;
  readonly onDeleteProfile?: (profileId: string) => void;
  readonly onSuggest?: () => void;
  readonly canSuggest?: boolean;
  readonly onSelectTeamSeat: (seatId: string | null) => void;
  readonly onCancelTeamSeat?: (seatId: string) => void;
  /** Stop every active member of the current run. */
  readonly onStopTeamRun?: () => void;
  readonly lastPrompt?: string;
  readonly onOpenPerson?: () => void;
}

/**
 * The main-column switch (spec §1.2). Two and only two surfaces:
 *   - 'person' → render `personView` (today's ChatPanel) unchanged
 *   - 'team'   → render <TeamSurface />
 *
 * The switch is intentionally thin — it does NOT own any state. App.tsx
 * owns `collaborationSurface` and the team projection; SurfaceHost just
 * routes. The fixture props are gone (Foundation spec §10.10): the
 * fixture lives in tests only.
 */
export function SurfaceHost(props: SurfaceHostProps): ReactElement {
  if (props.collaborationSurface === 'team') {
    return (
      <TeamSurface
        run={props.teamRun}
        composerLive={props.composerLive}
        composerDisabledReason={props.composerDisabledReason}
        templateProfiles={props.templateProfiles}
        customProfiles={props.customProfiles}
        modelChoices={props.modelChoices}
        onSelectSeat={props.onSelectTeamSeat}
        {...(props.onCancelTeamSeat ? { onCancelSeat: props.onCancelTeamSeat } : {})}
        {...(props.onStopTeamRun ? { onStopRun: props.onStopTeamRun } : {})}
        {...(props.onStartTeam ? { onStartTeam: props.onStartTeam } : {})}
        {...(props.onSaveProfileAs ? { onSaveProfileAs: props.onSaveProfileAs } : {})}
        {...(props.onDeleteProfile ? { onDeleteProfile: props.onDeleteProfile } : {})}
        {...(props.onSuggest ? { onSuggest: props.onSuggest } : {})}
        {...(props.canSuggest !== undefined ? { canSuggest: props.canSuggest } : {})}
        {...(props.lastPrompt ? { lastPrompt: props.lastPrompt } : {})}
        {...(props.onOpenPerson ? { onOpenPerson: props.onOpenPerson } : {})}
      />
    );
  }
  return <>{props.personView}</>;
}
