/**
 * Process env that tells the CLI which Team roster to load.
 *
 * Work must set TRYLO_TEAM_SURFACE=work even when the Tool Profile
 * failed to resolve — otherwise the child falls back to the Code
 * worktree worker. Code degrade leaves the var unset so the legacy
 * fingerprint stays `legacy:[]`.
 */
export const TRYLO_TEAM_SURFACE_ENV = 'TRYLO_TEAM_SURFACE';

export const TRYLO_TEAM_MODE_ENV = 'TRYLO_TEAM_MODE';

export function spawnEnvForTeamSurface(
  surface: 'code' | 'work' | undefined,
  base?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (surface !== 'work') {
    return base ?? {};
  }
  if (base?.[TRYLO_TEAM_SURFACE_ENV] === 'work') {
    return base;
  }
  return { ...(base ?? {}), [TRYLO_TEAM_SURFACE_ENV]: 'work' };
}

/**
 * Team Access (PR-7, spec §14.5): on Code the five-seat roster is only
 * listed when TRYLO_TEAM_MODE is set, so a spawn_team run adds it. Work
 * already lists the roster — MODE is redundant and must stay unset.
 * Setting MODE changes the env hash, so a warm CLI spawned during
 * stay_solo is never silently reused for spawn_team.
 */
export function spawnEnvForTeamAccess(
  surface: 'code' | 'work' | undefined,
  teamMode: boolean,
  base?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const withSurface = spawnEnvForTeamSurface(surface, base);
  if (surface === 'work') return withSurface;
  if (!teamMode) return withSurface;
  return { ...withSurface, [TRYLO_TEAM_MODE_ENV]: '1' };
}
