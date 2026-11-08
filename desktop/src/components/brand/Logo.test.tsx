import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo';

describe('Logo brand mark', () => {
  it('uses the unified mobile geometry (3 paths, stroke 60)', () => {
    const { container } = render(<Logo decorative />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(3);
    expect(container.querySelector('g')?.getAttribute('stroke-width')).toBe('60');
    // First path is the mobile launcher foreground's, verbatim.
    expect(paths[0]?.getAttribute('d')).toBe('M475 308 L475 444 L595 444');
  });

  it('paints the cream stroke for tone="cream" (mobile launcher colour)', () => {
    const { container } = render(<Logo decorative tone="cream" variant="solid" />);
    expect(container.querySelector('stop')?.getAttribute('stop-color')).toBe('#F3E3A6');
  });

  it('themes the chip paint while keeping its requested layout size', () => {
    const { container } = render(<Logo size={40} decorative tone="cream" variant="solid" withBg />);
    const chip = container.querySelector('.trilo-mark--chip') as HTMLElement;
    expect(chip.style.background).toBe('var(--logo-chip-bg, #111318)');
    expect(container.querySelector('stop')?.getAttribute('stop-color')).toBe('var(--logo-chip-ink, #F3E3A6)');
    expect(chip.style.width).toBe('40px');
    expect(chip.style.borderRadius).toBe('11px');
  });

  it('uses the selected small right/up optical correction', () => {
    const { container } = render(<Logo decorative />);
    // Preserve the selected adjustment across all uses without changing paths.
    const g = container.querySelector('g')!;
    expect(g.getAttribute('transform')).toBe('translate(-5 3.5)');
  });

  it('sizes the mark canvas for the chosen ink coverage inside the chip', () => {
    const { container } = render(<Logo size={40} decorative withBg />);
    const svg = container.querySelector('svg')!;
    // 1024 * 0.82 * 40 / 438 = 76.7 -> 77: deliberately LARGER than
    // the chip; logo.css pins flex-shrink: 0 so the chip cannot
    // flatten it (that bug shipped once in the preview already).
    expect(svg.getAttribute('width')).toBe('77');
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(40);
  });

  it('keeps a themed chip from sharing its paint server with an ordinary cream mark', () => {
    const { container } = render(<>
      <Logo decorative tone="cream" variant="solid" />
      <Logo decorative tone="cream" variant="solid" withBg />
    </>);
    const gradients = container.querySelectorAll('linearGradient');
    expect(gradients[0]?.id).not.toBe(gradients[1]?.id);
    expect(gradients[0]?.querySelector('stop')?.getAttribute('stop-color')).toBe('#F3E3A6');
    expect(gradients[1]?.querySelector('stop')?.getAttribute('stop-color')).toBe('var(--logo-chip-ink, #F3E3A6)');
  });

  it('isolates paint and accessible titles between two themed chips', () => {
    const { container } = render(<>
      <Logo tone="cream" variant="solid" withBg />
      <Logo tone="cream" variant="solid" withBg />
    </>);
    const ids = [...container.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll('svg')) {
      const gradient = svg.querySelector('linearGradient')!;
      const title = svg.querySelector('title')!;
      expect(svg.querySelector('g')?.getAttribute('stroke')).toBe(`url(#${gradient.id})`);
      expect(svg.getAttribute('aria-labelledby')).toBe(title.id);
    }
  });

  it('keeps the existing glow treatment when both wrapper flags are present', () => {
    const { container } = render(<Logo decorative tone="cream" variant="solid" withBg glow />);
    expect(container.querySelector('.trilo-mark--glow')).toBeTruthy();
    expect(container.querySelector('.trilo-mark--chip')).toBeNull();
    expect(container.querySelector('stop')?.getAttribute('stop-color')).toBe('#F3E3A6');
  });
});
