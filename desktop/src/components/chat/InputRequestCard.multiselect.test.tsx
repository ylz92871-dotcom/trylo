import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';
import { InputRequestCard } from './InputRequestCard';
import type { InputRequestMessage } from './types';
const message: InputRequestMessage = { id: 'q', role: 'assistant', createdAt: 1, kind: 'input_request', requestId: 'q', status: 'pending',
  questions: [{ id: 'style', header: '样式', question: '选择方向', multiSelect: true,
    options: [{ label: 'A', description: '方向 A' }, { label: 'B', description: '方向 B' }] }] };
it('lets the user select several options and submit one real answer', async () => {
  const onRespond = vi.fn(); render(<InputRequestCard message={message} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /A/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /B/ }));
  fireEvent.click(screen.getByRole('button', { name: /提交回答/ }));
  await waitFor(() => expect(onRespond).toHaveBeenCalledWith('q', 'submitted', { style: { optionLabels: ['A', 'B'] } }));
});
