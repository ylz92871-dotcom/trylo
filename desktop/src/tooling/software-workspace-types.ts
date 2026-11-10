export type SoftwareMode = 'window' | 'model'
export interface SoftwareApplication {
  readonly id?: string
  readonly pid?: number
  readonly name: string
  readonly path: string
  readonly kind: 'solidworks' | 'autocad' | 'application'
  readonly running?: boolean
}
export interface SoftwareWindow {
  readonly id: string
  readonly title: string
  readonly dialog: boolean
  readonly rect: readonly [number, number, number, number]
}
export interface SoftwareState {
  readonly scope: string
  readonly sessionId: string
  readonly revision: number
  readonly state: 'idle' | 'starting' | 'running' | 'stopped' | 'error'
  readonly detail: string
  readonly control: 'agent' | 'pending' | 'user'
  readonly inFlight: number
  readonly applications: readonly SoftwareApplication[]
  readonly windows: readonly SoftwareWindow[]
  readonly installed?: readonly SoftwareApplication[]
}
export interface SoftwareFrame {
  readonly sessionId: string
  readonly seq: number
  readonly windowId: string
  readonly mode: SoftwareMode
  readonly title: string
  readonly dialog: boolean
  readonly data: string
  readonly mimeType: 'image/jpeg'
  readonly width: number
  readonly height: number
  readonly timestamp: number
}
export type SoftwareKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'Delete'
  | 'ArrowLeft'
  | 'ArrowUp'
  | 'ArrowRight'
  | 'ArrowDown'
  | 'Space'
export type SoftwareInput =
  | {
      readonly kind: 'click'
      readonly windowId: string
      readonly x: number
      readonly y: number
      readonly button?: 'left' | 'right'
      readonly path?: readonly (readonly [number, number])[]
    }
  | {
      readonly kind: 'wheel'
      readonly windowId: string
      readonly x: number
      readonly y: number
      readonly delta: number
    }
  | { readonly kind: 'text'; readonly windowId: string; readonly text: string }
  | { readonly kind: 'key'; readonly windowId: string; readonly key: SoftwareKey }
export interface SoftwareScope {
  readonly projectRoot: string
  readonly conversationId: string
}
export type SoftwareCommand = SoftwareScope &
  (
    | { readonly operation: 'status' | 'close' }
    | { readonly operation: 'control'; readonly input: { readonly heldByUser: boolean } }
    | { readonly operation: 'open'; readonly input: { readonly path: string } }
    | {
        readonly operation: 'snapshot'
        readonly input: { readonly windowId?: string; readonly mode: SoftwareMode }
      }
    | {
        readonly operation: 'view'
        readonly input: { readonly preset: 'isometric' | 'front' | 'top' | 'right' }
      }
    | {
        readonly operation: 'resize'
        readonly input: {
          readonly windowId: string
          readonly width: number
          readonly height: number
        }
      }
    | { readonly operation: 'input'; readonly input: SoftwareInput }
  )
export type SoftwareResult = SoftwareState | SoftwareFrame | { readonly ok: boolean }

export function softwareScopeKey(scope: SoftwareScope): string {
  return JSON.stringify([
    scope.projectRoot.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(),
    scope.conversationId,
  ])
}
