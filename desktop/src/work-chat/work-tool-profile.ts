import type { TryloSettings } from '../settings/settings-store'

type WorkToolSettings = Pick<TryloSettings, 'workComputer' | 'workBrowserDebug' | 'workCad'>

function profileId(browserDebug: boolean, cad: boolean): string | undefined {
  if (browserDebug && cad) return 'work.cad-browser-debug.v1'
  if (browserDebug) return 'work.browser-debug.v1'
  if (cad) return 'work.cad.v1'
  return undefined
}

/** One settings snapshot for local, remote and reopened Work user sends. */
export function workToolProfile(settings: WorkToolSettings): {
  readonly requestedProfileId?: string
  readonly computerUse: boolean
} {
  const requestedProfileId = profileId(settings.workBrowserDebug, settings.workCad)
  return { ...(requestedProfileId ? { requestedProfileId } : {}), computerUse: settings.workComputer }
}
