import { useState, type ReactElement } from 'react'
import { Send } from 'lucide-react'
import type { SoftwareKey } from '../../tooling/software-workspace-types'

export function SoftwareInputBar({
  busy,
  onText,
  onKey,
}: {
  readonly busy: boolean
  readonly onText: (text: string) => Promise<void>
  readonly onKey: (key: SoftwareKey) => Promise<void>
}): ReactElement {
  const [text, setText] = useState('')
  return (
    <div className="software-workspace__input-bar">
      <form
        className="software-workspace__text"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text) return
          void onText(text)
          setText('')
        }}
      >
        <input
          aria-label="输入到软件"
          placeholder="先点击软件中的输入框，再输入文字"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
        />
        <button type="submit" title="发送文字" aria-label="发送文字到软件" disabled={!text || busy}>
          <Send size={15} />
        </button>
      </form>
      <div className="software-workspace__keys">
        <span>发送按键</span>
        {(['Escape', 'Tab', 'Enter', 'Backspace'] as const).map((key) => (
          <button
            type="button"
            key={key}
            disabled={busy}
            onClick={() => {
              void onKey(key)
            }}
          >
            {{ Escape: 'Esc', Tab: 'Tab', Enter: 'Enter ↵', Backspace: '退格' }[key]}
          </button>
        ))}
      </div>
    </div>
  )
}
