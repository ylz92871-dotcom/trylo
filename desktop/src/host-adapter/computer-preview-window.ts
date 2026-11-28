import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './tauri-detect'
import type { ComputerPreviewStatusEvent } from '../services-host/methods'
import type { PreviewAction, PreviewFrameGeometry } from '../tooling/tool-preview-state'

export interface ComputerPreviewSnapshot {
  readonly title: string
  readonly status: string
  readonly detail: string
  readonly dataUrl?: string
  readonly screenshotAt?: number
  readonly actions?: readonly PreviewAction[]
  readonly action?: PreviewAction
  readonly streamState?: ComputerPreviewStatusEvent['state']
  readonly streamDetail?: string
  readonly frameGeometry?: PreviewFrameGeometry
  readonly updatedAt?: number
  readonly scope?: string
}
export const EMPTY_COMPUTER_PREVIEW: ComputerPreviewSnapshot = {
  title: '电脑控制',
  status: '等待工具操作',
  detail: '工具返回截图后会显示在这里。',
}
export async function openComputerPreview(automatic = false): Promise<number | null> {
  if (!isTauri()) throw new Error('电脑悬浮窗需要在 Trylo 桌面应用中打开。')
  return invoke<number | null>('computer_preview_open', { automatic })
}
export async function onComputerPreviewClosed(handler: (scope: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<string>('computer-preview-closed', event => handler(event.payload))
}
export async function publishComputerPreview(snapshot: ComputerPreviewSnapshot): Promise<void> {
  if (isTauri()) await invoke('computer_preview_publish', { snapshot })
}
export async function observeComputerPreview(
  onSnapshot: (snapshot: ComputerPreviewSnapshot) => void,
): Promise<() => void> {
  let disposed = false
  const channel = new Channel<ComputerPreviewSnapshot>()
  channel.onmessage = snapshot => { if (!disposed) onSnapshot(snapshot) }
  await invoke('computer_preview_subscribe', { onSnapshot: channel })
  return () => { disposed = true }
}
