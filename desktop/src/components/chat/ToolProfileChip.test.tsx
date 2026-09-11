// Trylo Desktop — ToolProfileChip test. The chip answers "which tools does
// THIS conversation see" without leaving the composer.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolProfileChip } from './ToolProfileChip'

describe('ToolProfileChip', () => {
  it('shows the short label + server count for a known profile', () => {
    render(<ToolProfileChip profileId="work.cad.v1" />)
    const trigger = screen.getByRole('button', { name: /工具面：work\.cad\.v1/ })
    expect(trigger.textContent).toContain('CAD')
    expect(trigger.textContent).toContain('8组')
  })

  it('falls back to the default profile display for unknown ids (never blank)', () => {
    render(<ToolProfileChip profileId={null} />)
    expect(screen.getByRole('button', { name: /工具面：work\.core\.v1/ }).textContent).toContain(
      '办公',
    )
  })

  it('opens a popover with the expected server list + settings entry', () => {
    const onOpenSettings = vi.fn()
    render(<ToolProfileChip profileId="work.cad.v1" onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /工具面：work\.cad\.v1/ }))
    expect(screen.getByRole('dialog', { name: '当前工具面' })).toBeTruthy()
    expect(screen.getByText('trylo-office')).toBeTruthy()
    expect(screen.getByText('trylo-solidworks')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '去设置切换' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('is read-only without an onOpenSettings handler', () => {
    render(<ToolProfileChip profileId="work.core.v1" />)
    fireEvent.click(screen.getByRole('button', { name: /工具面：work\.core\.v1/ }))
    expect(screen.getByRole('dialog', { name: '当前工具面' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '去设置切换' })).toBeNull()
  })
})
