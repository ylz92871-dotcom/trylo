import type { ReactElement } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  dismissTeamRun,
  getComposerSnapshot,
  hasComposerDraft,
  isTeamRunDismissed,
  openComposerWithProfile,
  setComposerDraft,
  subscribeComposerDraft,
} from './composer/composer-draft';
import { idleRowsFromProfiles, rosterAllowsNoWorker } from './composer/composer-store';
import { TeamComposer } from './composer/TeamComposer';
import { TeamIdle } from './composer/TeamIdle';
import { TeamRunView } from './run/TeamRunView';
import { isTeamRunActive } from './team-store';
import type { ModelChoice } from './composer/composer-store';
import type { TeamProfile } from './team-profile-types';
import type { TeamRun } from './team-types';

export interface TeamSurfaceProps {
  /** Null = no run yet → idle. */
  readonly run: TeamRun | null;
  /** `teamAccessEnabled` (product treats composer as live off this flag). */
  readonly composerLive?: boolean;
  /** Builtin templates for the current TopLevelMode (App derives them
   *  from user-learning; surfaces cannot import it). */
  readonly templateProfiles?: readonly TeamProfile[];
  /** Saved custom profiles (App loads via the profiles cache). */
  readonly customProfiles?: readonly TeamProfile[];
  readonly modelChoices?: readonly ModelChoice[];
  /** PR-7 wires the launch (startTeamTurn). Absent ⇒ 开始 stays gated. */
  readonly onStartTeam?: (goal: string) => void | Promise<void>;
  readonly onSaveProfileAs?: (name: string) => void;
  readonly onDeleteProfile?: (profileId: string) => void;
  readonly onSuggest?: () => void;
  readonly canSuggest?: boolean;
  readonly onSelectSeat: (seatId: string | null) => void;
  readonly onCancelSeat?: (seatId: string) => void;
  /** Stop every active member (existing handleCancelTeamSeat walk). */
  readonly onStopRun?: () => void;
  readonly composerDisabledReason?: string;
  readonly lastPrompt?: string;
  readonly onOpenPerson?: () => void;
}

type TeamView = 'run' | 'idle' | 'composer';

function initialView(run: TeamRun | null): TeamView {
  if (run && isTeamRunActive(run)) return 'run';
  if (hasComposerDraft()) return 'composer';
  if (run && run.seats.length > 0 && !isTeamRunDismissed(run.id)) return 'run';
  return 'idle';
}

/**
 * Team page shell (Foundation spec §10.2 / §10.5):
 *   - live run → run view (composer hidden while running, §11.5)
 *   - terminal run → stays in the run view with muted 「新团队」
 *   - no run → idle, or the composer when the singleton holds a draft
 *     (the draft survives CollaborationSwitch flips — Pitfall 18).
 */
export function TeamSurface(props: TeamSurfaceProps): ReactElement {
  const { run, onSelectSeat } = props;
  const { draft, launchError } = useSyncExternalStore(
    subscribeComposerDraft,
    getComposerSnapshot,
    getComposerSnapshot,
  );
  const [view, setView] = useState<TeamView>(() => initialView(run));
  const [launching, setLaunching] = useState(false);

  const isActiveRun = isTeamRunActive(run) && (run?.seats.length ?? 0) > 0;
  const runId = run?.id;
  useEffect(() => {
    if (isActiveRun) setView('run');
  }, [isActiveRun, runId]);
  const hasRun = run !== null;
  useEffect(() => {
    if (!hasRun) setView((v) => (v === 'run' ? 'idle' : v));
  }, [hasRun]);

  useEffect(() => {
    if (!run?.selectedSeatId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onSelectSeat(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run?.selectedSeatId, onSelectSeat]);

  const showRun = isActiveRun
    || (view === 'run' && run !== null && run.seats.length > 0 && !isTeamRunDismissed(run.id));

  if (showRun && run) {
    return (
      <div className="team-surface">
        <div className="team-surface__body">
          <TeamRunView
            run={run}
            onSelectSeat={props.onSelectSeat}
            {...(props.onCancelSeat ? { onCancelSeat: props.onCancelSeat } : {})}
            {...(props.onStopRun ? { onStopRun: props.onStopRun } : {})}
            {...(props.onOpenPerson ? { onOpenPerson: props.onOpenPerson } : {})}
            onNewTeam={() => {
              dismissTeamRun(run.id);
              setView('idle');
            }}
          />
        </div>
      </div>
    );
  }

  if (view === 'composer' && draft) {
    return (
      <div className="team-surface">
        <div className="team-surface__body">
          <TeamComposer
            draft={draft}
            modelChoices={props.modelChoices ?? []}
            composerLive={props.composerLive === true}
            allowNoWorker={rosterAllowsNoWorker(draft.members)}
            inFlight={launching}
            canOverwriteSaved={draft.profileId !== null}
            {...(launchError ? { errorText: launchError } : {})}
            onChange={(next) => setComposerDraft(next)}
            onStart={(goal) => {
              setLaunching(true);
              void Promise.resolve(props.onStartTeam?.(goal)).finally(() => {
                setLaunching(false);
              });
            }}
            onSaveAs={(name) => props.onSaveProfileAs?.(name)}
            onBackToIdle={() => setView('idle')}
          />
        </div>
      </div>
    );
  }

  // Draft was cleared (e.g. right after launch) while view was still
  // composer — fall through to idle. Active-run handling above already
  // wins once setTeamRun lands.

  const idleTemplates = props.templateProfiles
    ? idleRowsFromProfiles(props.templateProfiles)
    : undefined;
  const idleCustomProfiles = (props.customProfiles ?? []).map((p) => ({
    id: p.id,
    title: p.title,
  }));

  const openFromProfiles = (profiles: readonly TeamProfile[], id: string): void => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    openComposerWithProfile(profile, props.lastPrompt);
    setView('composer');
  };

  return (
    <div className="team-surface">
      <div className="team-surface__body">
        <TeamIdle
          composerLive={props.composerLive}
          disabledReason={props.composerDisabledReason}
          templates={idleTemplates}
          customProfiles={idleCustomProfiles}
          onOpenComposer={(templateId) => openFromProfiles(props.templateProfiles ?? [], templateId)}
          onOpenProfile={(profileId) => openFromProfiles(props.customProfiles ?? [], profileId)}
          {...(props.onDeleteProfile ? { onDeleteProfile: props.onDeleteProfile } : {})}
          {...(props.onSuggest
            ? {
              onSuggest: () => {
                // App seeds the draft from the mapped template (PR-8);
                // the surface then shows the composer. Still no spawn —
                // the user edits and clicks 开始 themselves (§8.5).
                props.onSuggest?.();
                if (hasComposerDraft()) setView('composer');
              },
            }
            : {})}
          {...(props.canSuggest !== undefined ? { canSuggest: props.canSuggest } : {})}
          {...(props.lastPrompt ? { lastPrompt: props.lastPrompt } : {})}
        />
      </div>
    </div>
  );
}
