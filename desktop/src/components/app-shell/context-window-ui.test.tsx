import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ModelContextSettings } from './ModelContextSettings'
import { ContextWindowFields } from './ContextWindowFields'
import { settingsDefaults } from '../../settings/settings-store'
import type { ModelContextPreference } from '../../settings/context-window'

vi.mock('../../account/use-platform-models', () => ({
  usePlatformModels: () => ({ models: [], loading: false, message: '' }),
}))
afterEach(cleanup)

it('shows the default context window and a declared-capacity field in model settings', () => {
  const change = vi.fn()
  render(<ModelContextSettings form={settingsDefaults} onChange={change} />)
  expect(screen.getByLabelText('上下文窗口')).toBeDefined()
  expect(screen.getByLabelText('模型或服务端上限（tokens）')).toBeDefined()
  expect(screen.getByRole('option', { name: '自动 · 默认 200K' })).toBeDefined()
  for (const name of ['400K', '600K', '800K', '1M']) {
    expect((screen.getByRole('option', { name }) as HTMLOptionElement).disabled).toBe(
      false,
    )
  }
  fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '128000' } })
  expect(change).toHaveBeenCalledWith(expect.any(Object))
})

it('offers larger windows after capacity is declared and preserves the requested window when capped', () => {
  function Harness() {
    const [preference, setPreference] = useState<ModelContextPreference>({})
    return (
      <ContextWindowFields
        preference={preference}
        serverCapacity={1_000_000}
        onChange={setPreference}
      />
    )
  }
  render(<Harness />)
  const capacity = screen.getByLabelText('模型或服务端上限（tokens）') as HTMLInputElement
  fireEvent.change(capacity, { target: { value: '1000000' } })
  fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '400000' } })
  expect(screen.getByText(/实际使用 400K/)).toBeDefined()
  for (const value of ['1', '12', '128', '1280', '12800', '128000']) {
    fireEvent.change(capacity, { target: { value } })
    expect((screen.getByLabelText('上下文窗口') as HTMLSelectElement).value).toBe('400000')
  }
  expect(screen.getByText(/实际使用 128K/)).toBeDefined()
  fireEvent.change(capacity, { target: { value: '-1' } })
  expect(capacity.validity.valid).toBe(false)
})

it('clears invalid capacity input when switching model connections', () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <ModelContextSettings onChange={onChange} form={{ ...settingsDefaults, apiModel: 'a' }} />,
  )
  fireEvent.change(screen.getByLabelText('模型或服务端上限（tokens）'), { target: { value: '-1' } })
  rerender(
    <ModelContextSettings onChange={onChange} form={{ ...settingsDefaults, apiModel: 'b' }} />,
  )
  expect(
    (screen.getByLabelText('模型或服务端上限（tokens）') as HTMLInputElement).validity.valid,
  ).toBe(true)
})
