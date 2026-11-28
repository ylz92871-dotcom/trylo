import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RailResizer } from './RailResizer'

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
}
beforeEach(() => { vi.stubGlobal('PointerEvent', TestPointerEvent) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('rail pointer capture', () => {
  it('captures the drag, ignores other pointers, and restores styles after cancellation', () => {
    const onChange = vi.fn()
    render(<RailResizer side="right" width={480} min={320} max={1000} onChange={onChange} />)
    const handle = screen.getByRole('separator')
    const capture = vi.fn(), release = vi.fn()
    Object.assign(handle, { setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: release })
    document.body.style.cursor = 'text'
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 800 })
    expect(capture).toHaveBeenCalledWith(7)
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 200 })
    fireEvent.pointerUp(window, { pointerId: 8 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 700 })
    expect(onChange).toHaveBeenLastCalledWith(580)
    fireEvent.pointerCancel(window, { pointerId: 7 })
    expect(release).toHaveBeenCalledWith(7)
    expect(document.body.style.cursor).toBe('text')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 600 })
    expect(onChange).toHaveBeenCalledTimes(1)
    document.body.style.cursor = ''
  })
  it('releases an unfinished drag on unmount', () => {
    const onChange = vi.fn()
    const { unmount } = render(<RailResizer side="right" width={480} min={320} max={1000} onChange={onChange} />)
    const handle = screen.getByRole('separator')
    Object.assign(handle, { setPointerCapture: vi.fn() })
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 800 })
    unmount()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 700 })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')
  })
  it('supports magnetic snap hysteresis, double-click reset, and keyboard adjustments', () => {
    const onChange = vi.fn()
    render(
      <RailResizer
        side="left"
        width={220}
        min={184}
        max={360}
        snapPoints={[240]}
        defaultWidth={240}
        onChange={onChange}
      />,
    )
    const handle = screen.getByRole('separator')
    Object.assign(handle, { setPointerCapture: vi.fn() })

    // Drag into snap threshold (220 + 14 = 234 -> within +-10px of 240)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 200 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 214 })
    expect(onChange).toHaveBeenLastCalledWith(240)
    expect(handle).toHaveAttribute('data-snapped', 'true')

    // Small movement within exit hysteresis (+-16px) stays snapped
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 232 })
    expect(onChange).toHaveBeenLastCalledWith(240)

    // Moving past exit threshold unsnaps cleanly (220 + 40 = 260)
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 240 })
    expect(onChange).toHaveBeenLastCalledWith(260)
    expect(handle).not.toHaveAttribute('data-snapped')

    // Re-entering snap threshold snaps again
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 222 })
    expect(onChange).toHaveBeenLastCalledWith(240)
    fireEvent.pointerUp(window, { pointerId: 2 })

    // Double-click restores defaultWidth
    fireEvent.doubleClick(handle)
    expect(onChange).toHaveBeenLastCalledWith(240)

    // Keyboard navigation
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(236)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(240)
  })
})
