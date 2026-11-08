import { createContext } from 'react';
import type { WorkspaceEntry } from './LeftRail';

export interface WorkspaceNavigation {
  readonly workspaces: readonly WorkspaceEntry[];
  readonly currentWorkspaceId: string;
  readonly onSwitchWorkspace: (id: string) => void;
  readonly onOpenFolder: () => void;
}

// Navigation stays owned by App; composers only consume the shell's existing actions.
export const WorkspaceNavigationContext = createContext<WorkspaceNavigation | null>(null);
