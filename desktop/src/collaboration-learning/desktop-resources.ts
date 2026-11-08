import type { ToolLibraryClient } from '../tool-library/client'
import type { ExpertLibraryClient } from '../experts'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'
import type { CollaborationIssuesClient } from './issues-client'
import type { CliCommandRecoveryPort } from '../host-adapter/cli-command'

/** Host-created clients shared by settings and the next team composition boundary. */
export type DesktopCollaborationResources = {
  readonly scope: string
  readonly runtime: ToolLearningRuntime
  readonly issues: CollaborationIssuesClient
  readonly tools: ToolLibraryClient
  readonly experts: ExpertLibraryClient
  readonly libraryRecovery?: CliCommandRecoveryPort
}
