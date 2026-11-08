import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { AnswerLink } from './AnswerLink';
import type { ArtifactHost as HostAdapter } from '../../host-adapter/artifact-actions';

vi.mock('../../host-adapter/tauri-detect', () => ({ isTauri: () => true }));
function host(openFile: HostAdapter['openFile']): HostAdapter {
  return { openFile, openFileWithApp: vi.fn(), showInFolder: vi.fn(), copyToClipboard: vi.fn() };
}

describe('Answer links', () => {
  it('opens web links through the native host', () => {
    const open = vi.fn().mockResolvedValue(undefined);
    render(<AnswerLink href="https://example.com" artifactHost={host(open)}>Web</AnswerLink>);
    fireEvent.click(screen.getByRole('link', { name: 'Web' }));
    expect(open).toHaveBeenCalledWith('https://example.com');
  });
  it('keeps file links inside the actual file preview', () => {
    const open = vi.fn();
    render(<AnswerLink href="src/a.ts" onOpenArtifact={open}>File</AnswerLink>);
    fireEvent.click(screen.getByRole('link', { name: 'File' }));
    expect(open).toHaveBeenCalledWith('src/a.ts');
  });
  it('shows a readable host failure', async () => {
    render(<AnswerLink href="https://example.com" artifactHost={host(vi.fn().mockRejectedValue(new Error('browser unavailable')))}>Web</AnswerLink>);
    fireEvent.click(screen.getByRole('link', { name: 'Web' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('browser unavailable'));
  });
});
