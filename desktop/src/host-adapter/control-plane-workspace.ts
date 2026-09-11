import type { ControlPlaneClient } from '@trylo/work';
import { workspaceKey } from './conversation-history';

interface ControlPlaneWorkspace {
  readonly id: string;
  readonly path?: string;
}

interface WorkspaceListResponse {
  readonly workspaces?: readonly ControlPlaneWorkspace[];
}

interface WorkspaceCreateResponse {
  readonly workspace?: ControlPlaneWorkspace;
}

function workspaceAtPath(
  response: WorkspaceListResponse,
  root: string,
): ControlPlaneWorkspace | undefined {
  const target = workspaceKey(root);
  return response.workspaces?.find((workspace) =>
    typeof workspace.id === 'string'
    && typeof workspace.path === 'string'
    && workspaceKey(workspace.path) === target);
}

function isDuplicateWorkspaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('workspace.create failed')
    && message.includes('already exists');
}

export function isMissingControlPlaneWorkspaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('task.create failed')
    && message.includes('Workspace not found');
}

/**
 * Resolve the daemon's durable workspace id for a project folder.
 *
 * The daemon persists workspaces across renderer reloads, while the renderer's
 * in-memory id cache does not. Listing by path first keeps registration
 * idempotent. The second lookup handles two app windows racing to create the
 * same workspace.
 */
export async function resolveControlPlaneWorkspace(
  client: ControlPlaneClient,
  root: string,
  name: string,
): Promise<string> {
  const list = async (): Promise<ControlPlaneWorkspace | undefined> => {
    const response = await client.send<WorkspaceListResponse>('workspace.list');
    return workspaceAtPath(response, root);
  };

  const existing = await list();
  if (existing) return existing.id;

  try {
    const created = await client.send<WorkspaceCreateResponse>('workspace.create', {
      name,
      path: root,
    });
    if (!created.workspace?.id) {
      throw new Error('[ControlPlane] workspace.create returned no workspace id');
    }
    return created.workspace.id;
  } catch (error) {
    if (!isDuplicateWorkspaceError(error)) throw error;
    const raced = await list();
    if (raced) return raced.id;
    throw error;
  }
}
