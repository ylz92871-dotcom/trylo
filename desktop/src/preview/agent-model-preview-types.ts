/** Service commands are bound to the originating workspace and conversation. */
export interface AgentModelPreviewCommand {
  readonly id: string;
  readonly bridgeId: string;
  readonly scope: string;
  readonly projectRoot: string;
  readonly workspaceRoot?: string;
  readonly conversationId: string;
  readonly operation: 'open' | 'view' | 'snapshot' | 'close';
  readonly path?: string;
  readonly revision?: string | number;
  readonly fileSignature?: string;
  readonly autoRefresh?: boolean;
  readonly preset?: 'isometric' | 'front' | 'top' | 'right';
  readonly position?: readonly [number, number, number];
  readonly target?: readonly [number, number, number];
  readonly wireframe?: boolean;
  readonly fit?: boolean;
}

export interface AgentModelPreviewChanged {
  readonly bridgeId: string;
  readonly scope: string;
  readonly projectRoot: string;
  readonly workspaceRoot?: string;
  readonly conversationId: string;
  readonly path: string;
  readonly revision: string | number;
  readonly fileSignature?: string;
  readonly error?: string;
}
