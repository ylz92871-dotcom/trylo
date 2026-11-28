import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceSkillInstall } from './WorkspaceSkillInstall';

const workspaceRoot = '/fixture/project';
const url = 'https://example.com/helper/SKILL.md';
const query = () => vi.fn(async () => ({ ok: true, installed: { name: 'helper', directory: 'helper' } }));

afterEach(cleanup);

it('keeps the URL editable when the service is ready but its install interface is still missing', async () => {
  const install = query();
  const onInstalled = vi.fn();
  const view = render(<WorkspaceSkillInstall workspaceRoot={workspaceRoot} connected onInstalled={onInstalled} />);
  const input = screen.getByRole('textbox', { name: '从 URL 安装 Skill' });
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  expect(screen.getByRole('alert')).toHaveTextContent('技能安装入口尚未加载');
  expect(input).toHaveValue(url);

  view.rerender(<WorkspaceSkillInstall workspaceRoot={workspaceRoot} connected query={install} onInstalled={onInstalled} />);
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  expect(await screen.findByText('已安装 helper')).toBeInTheDocument();
  expect(install).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledWith({ op: 'install', workspaceRoot, url });
  expect(onInstalled).toHaveBeenCalledOnce();
});

it('retains the draft and sends it only after the existing service reload completes', async () => {
  const install = query();
  const onInstalled = vi.fn();
  const view = render(<WorkspaceSkillInstall workspaceRoot={workspaceRoot} connected needsReload query={install} onInstalled={onInstalled} />);
  const input = screen.getByRole('textbox', { name: '从 URL 安装 Skill' });
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  expect(screen.getByRole('alert')).toHaveTextContent('重载服务');
  expect(install).not.toHaveBeenCalled();
  view.rerender(<WorkspaceSkillInstall workspaceRoot={workspaceRoot} connected query={install} onInstalled={onInstalled} />);
  expect(input).toHaveValue(url);
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  expect(await screen.findByText('已安装 helper')).toBeInTheDocument();
  expect(install).toHaveBeenCalledOnce();
});
