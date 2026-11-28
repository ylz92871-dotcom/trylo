import { invoke } from '@tauri-apps/api/core';
import type { PetStatusSnapshot } from '../services-host/methods';
import type { CompanionPublishPayload } from './companion-port';
import { ServicesCompanionPort } from './companion-port';
import { AGENT_STATES } from './companion-projection';

export type CompanionDisplay = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

const displayedStates: Readonly<Record<string, CompanionDisplay | undefined>> = {
  [AGENT_STATES.idle]: 'idle',
  [AGENT_STATES.stalled]: 'waiting',
  [AGENT_STATES.done]: 'done',
  [AGENT_STATES.failed]: 'failed',
};

export class MacosCompanionPort extends ServicesCompanionPort {
  private display: CompanionDisplay = 'idle';
  private pendingApprovals = false;
  private enabled = false;

  override async start(): Promise<PetStatusSnapshot> {
    this.enabled = true;
    return this.enableChannel();
  }

  override async enableChannel(): Promise<PetStatusSnapshot> {
    await invoke('macos_companion_publish', { display: this.pendingApprovals ? 'waiting' : this.display });
    return this.snapshot(await invoke<boolean>('macos_companion_window', { action: 'show' }));
  }

  override async status(): Promise<PetStatusSnapshot> {
    return this.snapshot(await invoke<boolean>('macos_companion_window', { action: 'status' }));
  }

  override async stop(): Promise<void> {
    this.enabled = false;
    this.pendingApprovals = false;
    this.display = 'idle';
    await invoke('macos_companion_window', { action: 'hide' });
  }

  override async publish(event: CompanionPublishPayload): Promise<void> {
    if (event.type === 'permissionRequestState') {
      this.pendingApprovals = event.requests.length > 0;
    } else if (event.type === 'agentState') {
      this.display = displayedStates[event.state] ?? 'running';
    } else {
      this.display = event.type === 'error' ? 'failed' : event.type === 'stopped' ? 'stopped' : 'done';
    }
    if (this.enabled) await invoke('macos_companion_publish', {
      display: this.pendingApprovals ? 'waiting' : this.display,
    });
  }

  override openChat(): Promise<void> {
    return invoke('macos_companion_return');
  }

  private snapshot(visible: boolean): PetStatusSnapshot {
    return {
      enabled: this.enabled, exeFound: true, launchAttempted: this.enabled,
      launched: visible, chatConnected: visible, exePath: '', reasonCode: '',
    };
  }
}
