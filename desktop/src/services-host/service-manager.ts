// Trylo Desktop — Service Host lifecycle manager (renderer side).
//
// Owns the sidecar process lifecycle through the Tauri commands
// (`servicehost_spawn` / `servicehost_stop` / `servicehost_status`) and the
// frame client. Implements the crash-restart policy from migration spec
// §5.1: at most 3 restarts per 5 minutes with 1s/4s/16s backoff; beyond
// that the manager projects health 'down' and notifies — Code/Work keep
// working (degrade, never block).
//
// This is lifecycle wiring only: it holds no pet/learning/remote policy.

import { ServicesClient } from './services-client';

export type ServiceHealth = 'stopped' | 'starting' | 'ready' | 'restarting' | 'down';

export interface SpawnOptions {
  /** Resource dir containing desktop-companion/ (bridge exe lookup root). */
  readonly sidecarsDir: string;
  /** Tauri app_data_dir; the sidecar derives its storage root from it. */
  readonly appDataDir: string;
  /** Optional Hermes interpreter override (Phase 3). */
  readonly hermesPython?: string;
}

export interface ServiceManagerDeps {
  readonly invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly listen: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;
}

export interface ServiceManagerOptions {
  readonly restartBackoffMs?: readonly number[];
  readonly restartWindowMs?: number;
  readonly maxRestartsPerWindow?: number;
}

interface ServiceStatus {
  readonly running: boolean;
  readonly pid: number | null;
}

export class ServiceManager {
  readonly client: ServicesClient;

  private readonly invoke: ServiceManagerDeps['invoke'];
  private readonly restartBackoffMs: readonly number[];
  private readonly restartWindowMs: number;
  private readonly maxRestartsPerWindow: number;

  private health: ServiceHealth = 'stopped';
  private healthHandlers = new Set<(health: ServiceHealth) => void>();
  private downHandlers = new Set<() => void>();
  private spawnOptions: SpawnOptions | null = null;
  private restartTimestamps: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private downNotified = false;
  private startInFlight: Promise<void> | null = null;

  constructor(
    deps: ServiceManagerDeps,
    options: ServiceManagerOptions = {},
  ) {
    this.invoke = deps.invoke;
    this.restartBackoffMs = options.restartBackoffMs ?? [1_000, 4_000, 16_000];
    this.restartWindowMs = options.restartWindowMs ?? 5 * 60_000;
    this.maxRestartsPerWindow = options.maxRestartsPerWindow ?? 3;
    this.client = new ServicesClient(deps);
    this.client.onConnectionError = () => {
      void this.handleConnectionError();
    };
    this.client.onEvent('ready', () => {
      this.setHealth('ready');
    });
    this.client.onEvent('servicehost.exit', () => {
      void this.handleConnectionError();
    });
  }

  get currentHealth(): ServiceHealth {
    return this.health;
  }

  onHealth(handler: (health: ServiceHealth) => void): () => void {
    this.healthHandlers.add(handler);
    return () => {
      this.healthHandlers.delete(handler);
    };
  }

  /** Fired once when the restart budget is exhausted (servicehost.down). */
  onDown(handler: () => void): () => void {
    this.downHandlers.add(handler);
    return () => {
      this.downHandlers.delete(handler);
    };
  }

  /** Idempotent start: reuses a running host, otherwise spawns one. */
  async ensureRunning(options: SpawnOptions): Promise<void> {
    this.spawnOptions = options;
    this.downNotified = false;
    if (this.startInFlight) return this.startInFlight;
    const start = this.ensureRunningOnce();
    this.startInFlight = start;
    try {
      await start;
    } finally {
      if (this.startInFlight === start) this.startInFlight = null;
    }
  }

  private async ensureRunningOnce(): Promise<void> {
    if (this.health === 'ready' || this.health === 'starting') {
      const status = await this.status();
      if (status.running) return;
      this.setHealth('stopped');
    }
    await this.client.start();
    this.setHealth('starting');
    try {
      await this.spawn();
    } catch (err) {
      this.setHealth('stopped');
      throw err;
    }
  }

  /** Stop the sidecar (idempotent on the Rust side) and tear down the
   *  frame client. */
  async stop(): Promise<void> {
    this.cancelRestartTimer();
    this.restartTimestamps = [];
    // Do not let a concurrent startup finish after the stop and leave an
    // unowned sidecar behind. The Rust command is readiness-bounded, so this
    // wait is finite.
    await this.startInFlight?.catch(() => {});
    try {
      await this.invoke('servicehost_stop');
    } finally {
      this.setHealth('stopped');
    }
    await this.client.stop();
  }

  private async spawn(): Promise<void> {
    const options = this.spawnOptions;
    if (!options) throw new Error('ServiceManager.spawn requires spawn options');
    await this.invoke('servicehost_spawn', {
      sidecarsDir: options.sidecarsDir,
      appDataDir: options.appDataDir,
      hermesPython: options.hermesPython ?? null,
    });
  }

  private async status(): Promise<ServiceStatus> {
    const raw = (await this.invoke('servicehost_status')) as Partial<ServiceStatus> | undefined;
    return { running: Boolean(raw?.running), pid: raw?.pid ?? null };
  }

  private async handleConnectionError(): Promise<void> {
    if (this.health === 'down' || this.health === 'restarting') return;
    let running = true;
    try {
      running = (await this.status()).running;
    } catch {
      running = false;
    }
    if (running) return; // transient send failure, host is alive
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < this.restartWindowMs);
    if (this.restartTimestamps.length >= this.maxRestartsPerWindow) {
      this.setHealth('down');
      this.notifyDown();
      return;
    }
    const delay = this.restartBackoffMs[Math.min(this.restartTimestamps.length, this.restartBackoffMs.length - 1)];
    this.restartTimestamps.push(now);
    this.setHealth('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.respawn();
    }, delay);
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private async respawn(): Promise<void> {
    if (!this.spawnOptions) {
      this.setHealth('down');
      this.notifyDown();
      return;
    }
    try {
      await this.client.start();
      this.setHealth('starting');
      await this.spawn();
      // Health flips to 'ready' when the sidecar re-announces.
    } catch {
      this.setHealth('down');
      this.notifyDown();
    }
  }

  private notifyDown(): void {
    if (this.downNotified) return;
    this.downNotified = true;
    for (const handler of this.downHandlers) handler();
  }

  private setHealth(health: ServiceHealth): void {
    if (this.health === health) return;
    this.health = health;
    for (const handler of this.healthHandlers) handler(health);
  }
}
