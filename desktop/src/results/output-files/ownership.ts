/** Snapshot differences prove a change interval, not which concurrent agent
 * wrote it. Overlapping runs in one root therefore require scoped event
 * evidence; scan-only files are withheld instead of crossing conversations. */
export class OutputRunOwnership {
  private readonly runs = new Map<string, { root: string; projectKey: string; conversationId: string; ambiguous: boolean }>();
  begin(key: string, scope: { projectRoot: string; projectKey: string; conversationId: string }): void {
    if (this.runs.has(key)) return;
    let root = scope.projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[a-z]:/i.test(root)) root = root.toLowerCase();
    let ambiguous = false;
    for (const run of this.runs.values()) if (run.root === root) { run.ambiguous = true; ambiguous = true; }
    this.runs.set(key, { root, projectKey: scope.projectKey, conversationId: scope.conversationId, ambiguous });
  }
  finish(key: string): boolean {
    const run = this.runs.get(key);
    this.runs.delete(key);
    return !!run && !run.ambiguous;
  }
  clear(projectKey: string, conversationId?: string): void {
    for (const [key, run] of this.runs) if (run.projectKey === projectKey && (conversationId === undefined || run.conversationId === conversationId)) this.runs.delete(key);
  }
}

/** Shared only by the App's two projectors; tests can own isolated registries. */
export const desktopOutputOwnership = new OutputRunOwnership();
