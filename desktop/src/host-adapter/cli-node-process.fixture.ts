import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProcessService, ProcessHandle, LiveProcessInfo } from './process-service';
import type { ProcessId } from './types';

/** Real pipes implementing the native ProcessService contract for integration tests. */
export class NodeProcessFixture implements ProcessService {
  readonly children = new Map<ProcessId, ChildProcessWithoutNullStreams>();
  readonly exits = new Map<ProcessId, Promise<void>>();
  readonly argv: string[][] = [];
  readonly wire: string[] = [];
  readonly stderr: string[] = [];
  readonly forceStops: ProcessId[] = [];
  private readonly records = new Map<ProcessId, LiveProcessInfo>();
  private sequence = 0;

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async spawn(opts: Parameters<ProcessService['spawn']>[0]): Promise<ProcessHandle> {
    const id = `native-contract-${++this.sequence}` as ProcessId;
    const child = spawn(opts.command, [...opts.args], {
      cwd: opts.cwd, env: { ...this.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.children.set(id, child);
    this.argv.push([...opts.args]);
    createInterface({ input: child.stdout }).on('line', line => {
      this.wire.push(line);
      opts.onOutput(line);
    });
    createInterface({ input: child.stderr }).on('line', line => {
      this.stderr.push(line);
      opts.onStderr?.(line);
    });
    this.exits.set(id, new Promise(resolve => child.once('close', code => {
      this.children.delete(id);
      this.records.delete(id);
      opts.onExit?.({ id, pid: child.pid ?? 0, code, signal: null });
      resolve();
    })));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const handle = { id, pid: child.pid ?? 0, label: opts.label, command: opts.command };
    if (this.children.has(id)) this.records.set(id, { ...handle, metadata: opts.metadata ?? {} });
    return handle;
  }

  async send(id: ProcessId, message: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) throw new Error('process missing');
    await new Promise<void>((resolve, reject) => child.stdin.write(message.endsWith('\n') ? message : `${message}\n`,
      error => error ? reject(error) : resolve()));
  }

  async closeInput(id: ProcessId): Promise<void> { this.children.get(id)?.stdin.end(); }
  async stop(id: ProcessId): Promise<void> { this.forceStops.push(id); this.children.get(id)?.kill(); await this.exits.get(id); }
  async list(): Promise<readonly LiveProcessInfo[]> { return [...this.records.values()]; }
  async dispose(): Promise<void> { await Promise.all([...this.children.keys()].map(id => this.stop(id))); }
}
