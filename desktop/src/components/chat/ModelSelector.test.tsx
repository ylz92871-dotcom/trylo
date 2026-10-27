import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ModelSelector } from './ModelSelector';
const platform = vi.hoisted(() => ({ models: [{ id: 'grok-4.5', chat: true, pool: 'free', remaining: 1000 }], message: '', loading: false }));
vi.mock('../../account/use-platform-models', () => ({ usePlatformModels: () => platform }));
afterEach(() => { vi.restoreAllMocks(); platform.models = [{ id: 'grok-4.5', chat: true, pool: 'free', remaining: 1000 }]; });

function setup(): {
  onSelectConfigured: Mock;
  onSelectPool: Mock;
  onSelectProfile: Mock;
} {
  const onSelectConfigured = vi.fn();
  const onSelectPool = vi.fn();
  const onSelectProfile = vi.fn();
  render(
    <ModelSelector
      configuredModel="own-model"
      poolModel=""
      onSelectConfigured={onSelectConfigured}
      onSelectPool={onSelectPool}
      onSelectProfile={onSelectProfile}
    />,
  );
  return { onSelectConfigured, onSelectPool, onSelectProfile };
}

function openPopover(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
  return screen.getByRole('listbox', { name: 'Select model' });
}

describe('ModelSelector keyboard selection', () => {
  it('Enter picks the arrow-focused row, not the row current at open time', () => {
    const { onSelectPool, onSelectConfigured } = setup();
    openPopover();
    // Focus starts on the own-model row; one ArrowDown lands on the pool row.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectPool).toHaveBeenCalledWith('grok-4.5');
    expect(onSelectConfigured).not.toHaveBeenCalled();
  });

  it('Escape closes the popover and disarms Enter', () => {
    const { onSelectConfigured } = setup();
    openPopover();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Select model' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectConfigured).not.toHaveBeenCalled();
  });
});

describe('ModelSelector grouped list', () => {
  it('renders both group headings with the pool below a divider', () => {
    setup();
    const list = openPopover();
    expect(screen.getByText('我的配置')).toBeTruthy();
    expect(screen.getByText('免费算力池')).toBeTruthy();
    const headings = Array.from(list.querySelectorAll('.model-selector__group-heading')).map(
      (n) => n.textContent,
    );
    expect(headings).toEqual(['我的配置', '免费算力池']);
    expect(list.querySelector('.model-selector__divider')).toBeTruthy();
  });

  it('marks exactly the active row as selected', () => {
    render(
      <ModelSelector
        configuredModel="own-model"
        poolModel="grok-4.5"
        onSelectConfigured={vi.fn()}
        onSelectPool={vi.fn()}
      />,
    );
    openPopover();
    const selected = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('grok-4.5');
  });

  it('clicking a row selects it and closes the popover', () => {
    const { onSelectPool } = setup();
    openPopover();
    fireEvent.click(screen.getByText('grok-4.5'));
    expect(onSelectPool).toHaveBeenCalledWith('grok-4.5');
    expect(screen.queryByRole('listbox', { name: 'Select model' })).toBeNull();
  });
});

describe('ModelSelector long-list viewport', () => {
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 100, right: 460, width: 360, height, x: 100, y: top, toJSON() {} });
  const longModels = () => Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, chat: true, pool: 'free', remaining: 1000 }));

  it('repositions when asynchronously loaded models outgrow the opening menu', () => {
    platform.models = [];
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'listbox' ? this.querySelectorAll('[role="option"]').length * 44 + 40 : 0; });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.tagName === 'BUTTON' ? rect(470, 20) : rect(0, 0); });
    const props = { configuredModel: 'own', poolModel: '', onSelectConfigured: vi.fn(), onSelectPool: vi.fn() };
    const view = render(<ModelSelector {...props} />);
    const menu = openPopover(), initialTop = Number.parseFloat(menu.style.top);
    platform.models = longModels(); view.rerender(<ModelSelector {...props} />);
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(initialTop);
    expect(Number.parseFloat(menu.style.maxHeight)).toBe(450);
    expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBeLessThan(600);
  });

  it('Home/End reveal the focused row inside the menu and Enter selects it', () => {
    platform.models = longModels();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'listbox' ? 200 : 0; });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'listbox') return rect(100, 200);
      if (this.getAttribute('role') === 'option') {
        const menu = this.closest('[role="listbox"]') as HTMLElement;
        const index = Array.from(menu.querySelectorAll('[role="option"]')).indexOf(this);
        return rect(100 + index * 40 - menu.scrollTop, 40);
      }
      return rect(450, 20);
    });
    const { onSelectPool } = setup(), menu = openPopover();
    fireEvent.keyDown(document, { key: 'End' });
    expect(menu.scrollTop).toBe(240);
    expect(menu.querySelector('.model-selector__item--focus')?.textContent).toContain('model-9');
    fireEvent.keyDown(document, { key: 'Home' }); expect(menu.scrollTop).toBe(0);
    fireEvent.keyDown(document, { key: 'ArrowUp' }); expect(menu.scrollTop).toBe(240);
    fireEvent.keyDown(document, { key: 'Enter' }); expect(onSelectPool).toHaveBeenCalledWith('model-9');
  });

  it('hovering a partly visible row does not snap the wheel scroll position', () => {
    platform.models = longModels(); setup(); const menu = openPopover(); menu.scrollTop = 120;
    fireEvent.mouseEnter(screen.getByText('model-6'));
    expect(menu.scrollTop).toBe(120);
  });
});
