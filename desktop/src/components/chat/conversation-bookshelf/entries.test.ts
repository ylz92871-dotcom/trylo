import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { conversationEntries, entryAtRow } from './entries';

describe('conversation bookshelf projection', () => {
  it('keeps stable IDs, user edits and correctly scoped late answers without changing history', () => {
    const messages: readonly ChatMessage[] = Object.freeze([
      { id: 'user-one', kind: 'text', role: 'user', text: 'first question', createdAt: 1 },
      {
        id: 'answer-one',
        kind: 'text',
        role: 'assistant',
        text: 'first answer',
        turnId: 'user-one',
        createdAt: 2,
      },
      { id: 'user-two', kind: 'text', role: 'user', text: 'second question', createdAt: 3 },
      {
        id: 'answer-two',
        kind: 'text',
        role: 'assistant',
        text: 'second answer',
        turnId: 'user-two',
        createdAt: 4,
      },
      {
        id: 'late-one',
        kind: 'text',
        role: 'assistant',
        text: 'late answer for first',
        turnId: 'user-one',
        createdAt: 5,
      },
    ] as const);
    expect(conversationEntries(messages)).toEqual([
      { id: 'user-one', title: 'first question', excerpt: 'late answer for first' },
      { id: 'user-two', title: 'second question', excerpt: 'second answer' },
    ]);
    expect(messages[0]).toMatchObject({ text: 'first question' });
  });
  it('does not treat tools, notices, thinking or assistant text as another question', () => {
    const messages: ChatMessage[] = [
      { id: 'system', kind: 'notice', role: 'system', text: 'notice', createdAt: 0 },
      { id: 'u', kind: 'text', role: 'user', text: 'question', createdAt: 1 },
      { id: 'a', kind: 'text', role: 'assistant', text: 'answer', createdAt: 2 },
    ];
    expect(conversationEntries(messages)).toEqual([
      { id: 'u', title: 'question', excerpt: 'answer' },
    ]);
    expect(
      entryAtRow(
        [
          { id: 'u', title: 'question', excerpt: 'answer', index: 3 },
          { id: 'v', title: 'next', excerpt: '', index: 10 },
        ],
        8,
      ),
    ).toBe('u');
    expect(
      entryAtRow(
        [
          { id: 'u', title: 'question', excerpt: 'answer', index: 3 },
          { id: 'v', title: 'next', excerpt: '', index: 10 },
        ],
        10,
      ),
    ).toBe('v');
    expect(entryAtRow([], 0)).toBeNull();
  });
});
