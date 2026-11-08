import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAvatarScope } from '../../../components/chat/AgentAvatar';
import { TeamMark } from './TeamMark';

afterEach(cleanup);
describe('Team avatar identity', () => {
  it('keeps twelve members distinct, including repeated roles, across embedded timeline scopes', () => {
    const identities = Array.from({ length: 12 }, (_, index) => `member-${index}`);
    const { container } = render(<AgentAvatarScope identities={identities}>
      <div data-layer="roster">{identities.map(identity => <TeamMark key={identity} role="worker" identity={identity} />)}</div>
      <AgentAvatarScope identities={[]} inherit><div data-layer="feed">{identities.map(identity => <TeamMark key={identity} role="worker" identity={identity} />)}</div></AgentAvatarScope>
    </AgentAvatarScope>);
    const variants = (layer: string): string[] => [...container.querySelectorAll(`[data-layer="${layer}"] [data-avatar]`)].map(mark => mark.getAttribute('data-avatar')!);
    expect(new Set(variants('roster')).size).toBe(12);
    expect(variants('feed')).toEqual(variants('roster'));
  });
  it('retains an identity when the label/role presentation changes and uses the actual brand for the coordinator', () => {
    const { container, rerender } = render(<TeamMark role="worker" identity="member-stable" />);
    const original = container.querySelector('[data-avatar]')?.getAttribute('data-avatar');
    rerender(<TeamMark role="reviewer" identity="member-stable" />);
    expect(container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe(original);
    rerender(<TeamMark role="personal" />);
    expect(container.querySelector('.team-mark--brand svg')?.getAttribute('viewBox')).toBe('0 0 1024 1024');
    expect(container.querySelector('[data-avatar]')).toBeNull();
  });
});
