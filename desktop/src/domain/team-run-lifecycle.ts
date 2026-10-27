/** The parent owns closure; an answered or parked member may still continue. */
export function isTeamRunOpen(run: { readonly status: string; readonly lifecycle?: 'open' | 'closed' }): boolean {
  if (run.lifecycle !== undefined) return run.lifecycle === 'open';
  return run.status === 'running' || run.status === 'waiting';
}
