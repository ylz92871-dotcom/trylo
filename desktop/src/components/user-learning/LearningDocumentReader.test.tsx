import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LearningDocumentReader, LearningMarkdown } from './LearningDocumentReader'
import { markdownBody, proposalDocument, snapshotDocument } from './learning-document'

afterEach(cleanup)

describe('learning document review', () => {
  it('unwraps only the known snapshot banner and preserves Markdown and blocked markers', () => {
    const body =
      '# 背景\r\n\r\n[BLOCKED: defence_in_depth_pattern_match]\r\n\r\nHeading\r\n=======\r\n'
    const source = '========\r\nUSER (user profile) [2% — 30/1,375 chars]\r\n========\r\n' + body
    expect(snapshotDocument(source, 'user')).toEqual({
      name: 'USER.md',
      source,
      content: body.trim(),
    })
    expect(snapshotDocument(body, 'memory').content).toBe(body.trim())
    expect(snapshotDocument(source, 'memory').content).toBe(source.trim())
  })

  it('renders tables and task lists, escapes HTML, and keeps frontmatter in source', () => {
    const source =
      '---\nname: example\n---\n# 实际技能\n\n| 输入 | 输出 |\n| --- | --- |\n| Markdown | HTML |\n\n- [x] 已验证\n\n<script>alert(1)</script>\n\n![secret](https://example.com/track)'
    const { container } = render(<LearningMarkdown content={source} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(markdownBody(source)).not.toContain('name: example')
  })

  it('uses the complete admin document and actual diff without a 6000 character cap', () => {
    const after = '# A skill\n\n' + 'full content '.repeat(900) + '\nEND-OF-DOCUMENT'
    const detail = {
      payloadHash: 'sha256:' + 'a'.repeat(64),
      after,
      before: 'old',
      diff: '-old\n+new',
      payload: { action: 'create', name: 'demo', content: after },
    }
    const doc = proposalDocument(detail, 'skills')
    render(<LearningDocumentReader title="Demo" document={doc} onClose={vi.fn()} />)
    expect(screen.getByText(/END-OF-DOCUMENT/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '差异' }))
    expect(screen.getByText(/-old\s+\+new/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /源码/ }))
    expect(screen.getByText(/END-OF-DOCUMENT/).textContent).toBe(after)
    fireEvent.click(screen.getByRole('button', { name: '写入详情' }))
    expect(screen.getByText(/payloadHash/)).toBeTruthy()
  })

  it('does not offer a fabricated diff for a backend without one', () => {
    render(
      <LearningDocumentReader
        title="Memory"
        document={proposalDocument({ after: 'Fact' }, 'memory')}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '差异' })).toHaveProperty('disabled', true)
  })

  it('preserves complete memory batch operations rather than the abbreviated summary', () => {
    const tail = 'complete operation tail '.repeat(100)
    const doc = proposalDocument(
      {
        action: 'batch',
        after: 'batch of 1 op(s): truncated',
        payload: { action: 'batch', operations: [{ action: 'add', content: tail }] },
      },
      'memory',
    )
    expect(doc.content).toContain(tail)
    expect(doc.source).toContain(tail)
  })

  it('restores the opener focus and underlying inert state when leaving the reader', () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<LearningDocumentReader title="Memory" onClose={onClose} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '智能体学习' }))
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(document.activeElement).toBe(opener)
    expect(opener.inert).toBeFalsy()
    opener.remove()
  })

  it('returns directory focus to its toggle before removing a selected heading control', () => {
    render(
      <LearningDocumentReader
        title="Skill"
        document={{ name: 'SKILL.md', content: '# 起点\n\n## 末尾\n\n完整内容。', source: '' }}
        onClose={vi.fn()}
      />,
    )
    const heading = screen.getByRole('heading', { name: '末尾' })
    heading.scrollIntoView = vi.fn()
    const toggle = screen.getByRole('button', { name: '目录' })
    fireEvent.click(toggle)
    const destination = screen.getByRole('button', { name: '末尾' })
    destination.focus()
    fireEvent.click(destination)

    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('navigation', { name: '文档目录' })).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('handles an unfocused document Escape only while mounted and honors the current busy state', () => {
    const onClose = vi.fn()
    const view = render(<LearningDocumentReader title="Skill" onClose={onClose} busy />)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    view.rerender(<LearningDocumentReader title="Skill" onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps independent reading, source and diff scroll positions', () => {
    const { container } = render(
      <LearningDocumentReader
        title="Skill"
        document={{ name: 'SKILL.md', content: '# 标题\n\n内容', source: '# 原文', diff: '-旧\n+新' }}
        onClose={vi.fn()}
      />,
    )
    const scroll = container.querySelector<HTMLElement>('.learning-reader__body')!
    scroll.scrollTop = 120
    fireEvent.click(screen.getByRole('button', { name: /源码/ }))
    expect(scroll.scrollTop).toBe(0)
    scroll.scrollTop = 45
    fireEvent.click(screen.getByRole('button', { name: '差异' }))
    expect(scroll.scrollTop).toBe(0)
    scroll.scrollTop = 30
    fireEvent.click(screen.getByRole('button', { name: '阅读' }))
    expect(scroll.scrollTop).toBe(120)
    fireEvent.click(screen.getByRole('button', { name: /源码/ }))
    expect(scroll.scrollTop).toBe(45)
    fireEvent.click(screen.getByRole('button', { name: '差异' }))
    expect(scroll.scrollTop).toBe(30)
  })
})
