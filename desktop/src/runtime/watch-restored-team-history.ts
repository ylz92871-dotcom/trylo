import { restoreTeamHistory, type RestoreTeamHistoryInput } from './restored-team-history';
import type { TeamRun } from '../surfaces/team/team-types';
import { isTeamRunOpen } from '../domain/team-run-lifecycle';

export interface WatchRestoredTeamHistoryInput extends RestoreTeamHistoryInput {
  readonly onRestored: (run: TeamRun | null) => void;
  readonly onError: (error: unknown) => void;
}
const backgroundObservers = new Map<string, () => void>();

/** Only disconnected/unknown ownership needs polling; live controllers own their events. */
export function watchRestoredTeamHistory(input: WatchRestoredTeamHistoryInput): () => void {
  let stopped = false;
  let background = false;
  let disposed = false;
  let firstCheck = true;
  let lastPublished: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const key = JSON.stringify([input.workspaceRoot, input.workspaceId, input.conversationId]);
  backgroundObservers.get(key)?.();
  const hasOwner = () => input.runtime.hasRecoveredOwner?.(input.projectKey ?? input.workspaceRoot, input.conversationId) ?? false;
  const current = () => !disposed && (background || !stopped && (input.isCurrent?.() ?? true));
  const dispose = () => {
    disposed = true; clearTimeout(timer);
    if (backgroundObservers.get(key) === dispose) backgroundObservers.delete(key);
  };
  const retainBackground = () => {
    background = true;
    backgroundObservers.set(key, dispose);
  };
  const refresh = async (): Promise<void> => {
    let retry = false;
    const onChecking = firstCheck ? input.onChecking : undefined;
    firstCheck = false;
    try {
      const run = await restoreTeamHistory({ ...input, onChecking, isCurrent: current });
      // A pending native read may acquire ownership just after navigation.
      // Its uncommitted output remains queued and is read on the next poll.
      if (!current()) {
        if (stopped && !disposed && hasOwner()) retainBackground();
        else return;
      }
      const snapshot = JSON.stringify(run);
      if (!stopped && snapshot !== lastPublished) {
        input.onRestored(run);
        lastPublished = snapshot;
      }
      retry = run?.recovery?.kind === 'detached' || run?.recovery?.kind === 'unavailable'
        || hasOwner() || Boolean(run && isTeamRunOpen(run)
          && !input.runtime.hasLocalOwner(input.projectKey ?? input.workspaceRoot, input.conversationId));
    } catch (error) {
      if (!current()) return;
      input.onError(error);
      retry = true;
    }
    // A completed read owns the next timer; slow IPC never accumulates polls.
    if (retry && current()) timer = setTimeout(() => { timer = undefined; void refresh(); }, 1000);
    else if (background) dispose();
  };
  void refresh();
  return () => {
    stopped = true;
    // Reconnected execution is supervised independently of visible selection.
    // Only its cache/chat sink survives; it cannot replace the new visible team.
    if (!disposed && hasOwner()) retainBackground();
    else clearTimeout(timer);
  };
}
