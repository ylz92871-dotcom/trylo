import { invoke } from '@tauri-apps/api/core';
import type { TeamRunsStorage } from '../user-learning/team-access/profiles/team-runs-persistence';

export const teamRunsStorage: TeamRunsStorage = {
  load: workspaceRoot => invoke('team_runs_load', { workspaceRoot }),
  save: (workspaceRoot, expected, json) => invoke('team_runs_save', { workspaceRoot, expected, json }),
};
