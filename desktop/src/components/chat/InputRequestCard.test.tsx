// Trylo Desktop — InputRequestCard (M4-E).
//
// Inline structured user-input question set. Pins:
//   - pending renders one radio group per question;
//   - Submit is disabled until every question is answered;
//   - Submit calls the responder with the selected options;
//   - Dismiss calls the responder with status=dismissed;
//   - submitted renders the given answers read-only.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InputRequestCard } from './InputRequestCard';
import type { InputRequestMessage } from './types';

afterEach(() => cleanup());

const QUESTIONS = [
  {
    id: 'outcome',
    header: 'Outcome',
    question: 'What should the task deliver?',
    options: [
      { label: 'Report', description: 'Written report' },
      { label: 'No file', description: 'Answer only' },
    ],
  },
];

function requestMessage(over: Partial<InputRequestMessage> = {}): InputRequestMessage {
  return {
    id: 'input_request:run:task-1:ir-1',
    kind: 'input_request',
    role: 'system',
    createdAt: 1000,
    requestId: 'ir-1',
    questions: QUESTIONS,
    status: 'pending',
    ...over,
  };
}

describe('InputRequestCard (M4-E)', () => {
  it('pending renders every question with its options', () => {
    render(<InputRequestCard message={requestMessage()} />);
    expect(screen.getByText('What should the task deliver?')).toBeTruthy();
    expect(screen.getByText('Report')).toBeTruthy();
    expect(screen.getByText('No file')).toBeTruthy();
  });

  it('Submit is disabled until every question is answered', () => {
    render(<InputRequestCard message={requestMessage()} onRespond={vi.fn()} />);
    const submit = screen.getByText('Submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Report/));
    expect(submit.disabled).toBe(false);
  });

  it('Submit responds with the selected answers', () => {
    const onRespond = vi.fn();
    render(<InputRequestCard message={requestMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByLabelText(/No file/));
    fireEvent.click(screen.getByText('Submit'));
    expect(onRespond).toHaveBeenCalledWith('ir-1', 'submitted', {
      outcome: { optionLabel: 'No file' },
    });
  });

  it('Dismiss responds with status=dismissed', () => {
    const onRespond = vi.fn();
    render(<InputRequestCard message={requestMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onRespond).toHaveBeenCalledWith('ir-1', 'dismissed', undefined);
  });

  it('submitted renders the answers read-only with no inputs', () => {
    render(
      <InputRequestCard
        message={requestMessage({
          status: 'submitted',
          answers: { outcome: { optionLabel: 'Report' } },
        })}
      />,
    );
    expect(screen.getByText('Submitted')).toBeTruthy();
    expect(screen.getByText('Report')).toBeTruthy();
    expect(screen.queryByText('Submit')).toBeNull();
    expect(screen.queryByText('Dismiss')).toBeNull();
  });

  it('dismissed renders a read-only state', () => {
    render(<InputRequestCard message={requestMessage({ status: 'dismissed' })} />);
    expect(screen.getByText('Dismissed')).toBeTruthy();
    expect(screen.queryByText('Submit')).toBeNull();
  });

  it('"Other" reveals a free-text box and is not submittable until text is entered', () => {
    const onRespond = vi.fn();
    render(<InputRequestCard message={requestMessage()} onRespond={onRespond} />);
    const submit = screen.getByText('Submit') as HTMLButtonElement;
    // Without any selection Submit is disabled.
    expect(submit.disabled).toBe(true);
    // Picking "Other" alone does NOT yet count as an answer.
    fireEvent.click(screen.getByLabelText(/Other/));
    expect(submit.disabled).toBe(true);
    // Typing custom text satisfies the question.
    fireEvent.change(screen.getByLabelText(/What should the task deliver\? — other/), {
      target: { value: 'A short email' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith('ir-1', 'submitted', {
      outcome: { otherText: 'A short email' },
    });
  });
});
