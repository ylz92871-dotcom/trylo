// Trylo Desktop — pet status text tests (audit §4.2 PET-P0-1).
// The UI must show a FIXED, path-free line per reason code.

import { describe, expect, it } from 'vitest';

import type { PetStatusSnapshot } from '../services-host/methods';
import { petStatusDetail, petStatusHeadline, petStatusTone } from './pet-status-text';

function status(overrides: Partial<PetStatusSnapshot> = {}): PetStatusSnapshot {
  return {
    enabled: false,
    exeFound: false,
    launchAttempted: false,
    launched: false,
    chatConnected: false,
    exePath: '',
    reasonCode: '',
    ...overrides,
  };
}

describe('petStatusHeadline', () => {
  it('reports Running only when launched AND connected', () => {
    expect(petStatusHeadline(status({ launched: true, chatConnected: true }))).toBe('Running');
    expect(petStatusHeadline(status({ launched: true, chatConnected: false }))).toBe('Starting');
  });

  it('distinguishes "not available" from "not running"', () => {
    expect(petStatusHeadline(status({ exeFound: false, reasonCode: 'exe_not_found' }))).toBe(
      'Not available',
    );
    expect(petStatusHeadline(status({ exeFound: true, reasonCode: 'spawn_failed' }))).toBe(
      'Not running',
    );
  });
});

describe('petStatusDetail', () => {
  it('is empty when the pet is up', () => {
    expect(petStatusDetail(status({ launched: true, chatConnected: true }))).toBe('');
  });

  it('gives an actionable line per reason code', () => {
    for (const reasonCode of [
      'exe_not_found',
      'no_sidecars_dir',
      'bridge_module_missing',
      'spawn_failed',
      'spawn_no_pid',
      'unsupported_platform',
    ]) {
      expect(petStatusDetail(status({ exeFound: true, reasonCode }))).not.toBe('');
    }
  });

  it('says nothing before any attempt — no noise on a fresh install', () => {
    expect(petStatusDetail(status({ reasonCode: 'not_attempted' }))).toBe('');
    expect(petStatusDetail(status({ reasonCode: '' }))).toBe('');
  });

  it('never leaks an unknown code into the UI', () => {
    // The raw code may carry a private path; only the generic line is shown.
    const detail = petStatusDetail(status({ reasonCode: 'C:\\Users\\alice\\secret' }));
    expect(detail).toBe('The pet is not running.');
    expect(detail).not.toContain('alice');
  });
});

describe('petStatusTone', () => {
  it('maps launched/connected to ok, pending, or error', () => {
    expect(petStatusTone(status({ launched: true, chatConnected: true }))).toBe('ok');
    expect(petStatusTone(status({ launched: true, chatConnected: false }))).toBe('pending');
    expect(petStatusTone(status({ reasonCode: 'not_attempted' }))).toBe('pending');
    expect(petStatusTone(status({ reasonCode: 'exe_not_found' }))).toBe('error');
  });
});
