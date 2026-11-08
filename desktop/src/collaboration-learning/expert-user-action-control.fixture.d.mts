import type {
  ExpertConfiguration,
  ExpertLibrarySnapshot,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import type { ExpertCommand } from '../experts/client'
import type { CliCommandResult } from '../host-adapter/cli-command'
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
import type { createDesktopLibraryClients } from './library-clients'

/** Public DTO boundary for the Node-only compiled CLI integration fixture. */
export function productionChain(
  buildRoot: string,
  configuration: ExpertConfiguration,
  transport: { send: (id: string, line: string) => Promise<void> },
  workspaceRoot: string,
): Promise<{
  clients: ReturnType<typeof createDesktopLibraryClients>
  supervisor: ConversationRunSupervisor
  lines: string[]
  outputs: string[]
  ordinary: (command: ExpertCommand) => Promise<CliCommandResult>
  snapshot: () => ExpertLibrarySnapshot
}>
