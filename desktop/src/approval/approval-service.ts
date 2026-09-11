// Trylo Desktop — ApprovalService (migration spec §6.4).
//
// Single entry point for pet-driven permission decisions
// (`host.permissionDecision` → `decide(requestId, decision)`). Routes by
// requestId to the owning authority:
//   - Work path: the workd daemon's approval.respond (approvalId aligned
//     — the pet publishes workd approvalIds verbatim);
//   - Code path: the CLI stdio permission registry (requestId generated
//     by the CLI process; answered via control_response).
//
// The service never guesses: a requestId neither authority currently has
// pending is reported through `onUnrouted` (diagnostics) and resolves
// false. Routing is by the id CARRIED BY THE REQUEST (spec §6.3: 禁止用
// "当前选中" 猜) so dual workspaces cannot cross wires.

export interface ApprovalDecision {
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
}

/** Work authority surface (the WorkRuntime). */
export interface WorkApprovalAuthority {
  /** Is this approvalId currently pending in the daemon? */
  isPending(approvalId: string): boolean;
  respond(approvalId: string, approved: boolean): Promise<void>;
}

/** Code authority surface (the CodePermissionRegistry). */
export interface CodeApprovalAuthority {
  isPending(requestId: string): boolean;
  respond(requestId: string, allow: boolean): Promise<boolean>;
}

export interface ApprovalServiceOptions {
  readonly work?: WorkApprovalAuthority | null;
  readonly code?: CodeApprovalAuthority | null;
  /** Fired when no authority owns the requestId (stale pet decision,
   *  already-resolved approval, …). Observability only — never throws. */
  readonly onUnrouted?: (decision: ApprovalDecision) => void;
}

export class ApprovalService {
  private readonly work: WorkApprovalAuthority | null;
  private readonly code: CodeApprovalAuthority | null;
  private readonly onUnrouted: ((decision: ApprovalDecision) => void) | null;

  constructor(options: ApprovalServiceOptions = {}) {
    this.work = options.work ?? null;
    this.code = options.code ?? null;
    this.onUnrouted = options.onUnrouted ?? null;
  }

  /** Route one decision. Resolves true when an authority accepted it. */
  async decide(requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
    const allow = decision === 'allow';
    if (this.work?.isPending(requestId)) {
      await this.work.respond(requestId, allow);
      return true;
    }
    if (this.code?.isPending(requestId)) {
      return this.code.respond(requestId, allow);
    }
    this.onUnrouted?.({ requestId, decision });
    return false;
  }
}
