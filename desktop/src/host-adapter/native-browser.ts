import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './tauri-detect'

export interface NativeBrowserNavigationError { readonly url: string; readonly code?: string }
export interface NativeBrowserBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type NativeBrowserViewportRequest = { readonly mode: 'panel' } | { readonly mode: 'fixed'; readonly width: number; readonly height: number; readonly mobile?: boolean }
export type NativeBrowserViewport = { readonly mode: 'panel'; readonly scale: number; readonly width?: number; readonly height?: number } | { readonly mode: 'fixed'; readonly scale: number; readonly width: number; readonly height: number; readonly mobile?: boolean; readonly deviceScaleFactor?: number }
export interface NativeBrowserRecord {
  readonly scope: string
  readonly cdpPort: number
  readonly tabs: readonly { readonly label: string; readonly marker: string; readonly popup?: boolean }[]
  readonly activeLabel: string
  readonly bounds?: NativeBrowserBounds
  readonly zoom?: number
}
export interface NativeBrowserCommand {
  readonly scope: string
  readonly operation: 'ensure' | 'create' | 'close' | 'activate' | 'layout' | 'zoom' | 'navigate' | 'back' | 'forward' | 'reload' | 'focus'
  readonly label?: string
  readonly url?: string
  readonly bounds?: NativeBrowserBounds
  readonly visible?: boolean
  readonly zoom?: number
}
export interface NativeBrowserPageEvent { readonly scope: string; readonly label: string; readonly url?: string; readonly title?: string }
export interface NativeBrowserControlsEvent { readonly scope: string; readonly label?: string; readonly zoom?: number; readonly key?: 'Escape'; readonly error?: string }
export function nativeBrowserScope(projectRoot: string, conversationId: string): string {
  return JSON.stringify([projectRoot.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), conversationId])
}
export async function nativeBrowserCommand(command: NativeBrowserCommand): Promise<NativeBrowserRecord> {
  if (!isTauri()) throw new Error('原生浏览器需要在 Trylo 桌面应用中打开。')
  return invoke<NativeBrowserRecord>('native_browser_command', { command })
}
export async function onNativeBrowserPage(handler: (event: NativeBrowserPageEvent) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<NativeBrowserPageEvent>('trylo-native-browser-page', event => handler(event.payload))
}
export async function onNativeBrowserControls(handler: (event: NativeBrowserControlsEvent) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<NativeBrowserControlsEvent>('trylo-native-browser-controls', event => handler(event.payload))
}
