// Permission decisions route only to the current CLI request owner.
// An unknown or settled request never receives an inferred approval.

export interface ApprovalDecision {
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
}

/** Code authority surface (the CodePermissionRegistry). */
export interface CodeApprovalAuthority {
  isPending(requestId: string): boolean;
  respond(requestId: string, allow: boolean): Promise<boolean>;
}

export interface ApprovalServiceOptions {
  readonly code?: CodeApprovalAuthority | null;
  /** Fired when no authority owns the requestId (stale pet decision,
   *  already-resolved approval, …). Observability only — never throws. */
  readonly onUnrouted?: (decision: ApprovalDecision) => void;
}

export class ApprovalService {
  private readonly code: CodeApprovalAuthority | null;
  private readonly onUnrouted: ((decision: ApprovalDecision) => void) | null;

  constructor(options: ApprovalServiceOptions = {}) {
    this.code = options.code ?? null;
    this.onUnrouted = options.onUnrouted ?? null;
  }

  /** Route one decision. Resolves true when an authority accepted it. */
  async decide(requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
    const allow = decision === 'allow';
    if (this.code?.isPending(requestId)) {
      return this.code.respond(requestId, allow);
    }
    this.onUnrouted?.({ requestId, decision });
    return false;
  }
}
