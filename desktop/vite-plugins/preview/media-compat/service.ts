import { mkdir, mkdtemp, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import policy from '../../../src/preview/providers/media-policy.json';
import { mediaByteRanges, mediaProbeArguments, mediaSegmentCount, mediaStreamArguments, parseMediaInfo, type MediaInfo } from '../../../src/preview/providers/media-playlist';
import { verifyMediaEngine } from '../../../scripts/preview/media-engine.mjs';
import { probeMedia, spawnMedia } from './process';

interface Worker { start: number; next: number; want: number; controller: AbortController; task: Promise<void> }
interface Session {
  target: string; size: number; modifiedMs: number; info?: MediaInfo;
  closed: boolean; opening: AbortController; worker?: Worker; error?: Error;
  cache: Map<number, Buffer>; bytes: number; waiters: Set<() => void>; requests: number;
  requestVersion: number; lastRequestIndex: number;
}
export class MediaCompatibility {
  private readonly sessions = new Map<string, Session>();
  private engine?: Promise<{ encoder: string; probe: string }>;
  private jobs = 0;
  constructor(private readonly cacheRoot: string, private readonly engineRoot?: string) {}
  private executables() { return this.engine ??= verifyMediaEngine(this.engineRoot); }
  private changed(session: Session) { for (const wake of session.waiters) wake(); session.waiters.clear(); }
  private slot(): () => void {
    if (this.jobs >= policy.maxConcurrentJobs) throw new Error('媒体兼容引擎繁忙，请稍后重试');
    this.jobs++; return () => { this.jobs--; };
  }
  async open(token: string, target: string): Promise<MediaInfo> {
    if (!/^[\da-z-]{32,64}$/i.test(token) || this.sessions.has(token)) throw new Error('媒体预览标识无效');
    if (this.sessions.size >= policy.maxSessions) throw new Error('打开的媒体过多，请关闭部分预览');
    const session: Session = { target, size: 0, modifiedMs: 0, closed: false, opening: new AbortController(), cache: new Map(), bytes: 0, waiters: new Set(), requests: 0, requestVersion: 0, lastRequestIndex: 0 };
    // Reserve before probing: close can cancel an opening grant too.
    this.sessions.set(token, session);
    try {
      const meta = await stat(target);
      if (!meta.isFile()) throw new Error('媒体路径不是文件');
      session.size = meta.size; session.modifiedMs = meta.mtimeMs;
      const engine = await this.executables();
      session.opening.signal.throwIfAborted();
      const release = this.slot();
      try { session.info = parseMediaInfo(await probeMedia(engine.probe, mediaProbeArguments(), target, session.opening.signal)); }
      finally { release(); }
      if (session.closed || this.sessions.get(token) !== session) throw new Error('媒体预览已关闭');
      return session.info;
    } catch (error) { await this.close(token); throw error; }
  }
  info(token: string): MediaInfo {
    const info = this.sessions.get(token)?.info;
    if (!info) throw new Error('媒体预览已关闭'); return info;
  }
  private async unchanged(session: Session) {
    const meta = await stat(session.target);
    if (!meta.isFile() || (await realpath(session.target)).toLowerCase() !== path.resolve(session.target).toLowerCase() || meta.size !== session.size || meta.mtimeMs !== session.modifiedMs) throw new Error('文件已更新，请重新加载预览');
  }
  private cache(session: Session, index: number, bytes: Buffer) {
    const limit = Math.floor(policy.maxCacheBytes / policy.maxSessions);
    if (bytes.length > limit) throw new Error('媒体片段超过缓存限制');
    while (session.bytes + bytes.length > limit) {
      const oldest = session.cache.keys().next().value;
      if (oldest === undefined) break;
      session.bytes -= session.cache.get(oldest)!.length; session.cache.delete(oldest);
    }
    const previous = session.cache.get(index); if (previous) session.bytes -= previous.length;
    session.cache.delete(index); session.cache.set(index, bytes); session.bytes += bytes.length;
    this.changed(session);
  }
  private wait(session: Session, delay: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, delay); session.waiters.add(wake);
    });
  }
  private async produce(session: Session, worker: Worker): Promise<void> {
    const release = this.slot();
    let directory: string | undefined;
    let job: ReturnType<typeof spawnMedia> | undefined;
    const signal = worker.controller.signal;
    const stop = () => { job?.stop(); this.changed(session); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const engine = await this.executables(); signal.throwIfAborted();
      await mkdir(this.cacheRoot, { recursive: true });
      if ((await realpath(this.cacheRoot)).toLowerCase() !== path.resolve(this.cacheRoot).toLowerCase()) throw new Error('媒体缓存目录被重定向');
      directory = await mkdtemp(path.join(this.cacheRoot, 'stream-'));
      const playlistPath = path.join(directory, 'stream.m3u8');
      await this.unchanged(session); signal.throwIfAborted();
      job = spawnMedia(engine.encoder, mediaStreamArguments(worker.start, session.info!, playlistPath), session.target, directory);
      if (signal.aborted) job.stop();
      let pending: Buffer = Buffer.alloc(0); let consumed = 0; let rangeIndex = 0;
      const count = mediaSegmentCount(session.info!.duration);
      const publish = async (finished: boolean) => {
        const meta = await stat(playlistPath).catch(() => undefined);
        if (!meta) return;
        if (meta.size > policy.maxPlaylistBytes) throw new Error('媒体分段清单过大');
        const ranges = mediaByteRanges(await readFile(playlistPath, 'utf8'));
        while (rangeIndex < ranges.length) {
          const range = ranges[rangeIndex]!;
          const index = worker.start + rangeIndex;
          if (index === count - 1) {
            // A short AAC/container tail is merged into the final URI, never
            // silently discarded because duration rounded across a boundary.
            if (!finished) break;
            const remaining = ranges.slice(rangeIndex).reduce((sum, entry) => sum + entry.size, 0);
            if (range.offset !== consumed || remaining !== pending.length) throw new Error('媒体尾段不完整');
            this.cache(session, index, pending); consumed += remaining; pending = Buffer.alloc(0); rangeIndex = ranges.length; worker.next = count; break;
          }
          if (index >= count) throw new Error('媒体实际时长与轨道信息不一致');
          if (range.offset !== consumed) throw new Error('媒体片段偏移无效');
          if (pending.length < range.size) break;
          this.cache(session, index, Buffer.from(pending.subarray(0, range.size)));
          pending = pending.subarray(range.size); consumed += range.size; rangeIndex++; worker.next = index + 1;
        }
      };
      for await (const chunk of job.child.stdout) {
        signal.throwIfAborted();
        pending = Buffer.concat([pending, chunk as Buffer]);
        if (pending.length > policy.maxSegmentBytes) throw new Error('媒体片段超过 16 MB 限制');
        await publish(false);
        while (worker.next > worker.want + policy.prefetchSegments && worker.next < count) {
          const want = worker.want;
          const until = Date.now() + policy.segmentTimeoutMs;
          while (worker.want === want) {
            const remaining = until - Date.now();
            if (remaining <= 0) return; // Idle stop; cached pieces remain.
            await this.wait(session, remaining); signal.throwIfAborted();
          }
        }
      }
      await job.done; signal.throwIfAborted(); await publish(true);
      if (worker.next < count || pending.length) throw new Error('媒体文件在预期结束位置之前中断');
    } finally {
      signal.removeEventListener('abort', stop); job?.stop(); await job?.done.catch(() => {});
      if (directory) {
        for (const name of ['stream.m3u8', 'stream.m3u8.tmp']) await unlink(path.join(directory, name)).catch(() => {});
        await rmdir(directory).catch(() => {});
      }
      release();
    }
  }
  async segment(token: string, index: number): Promise<Buffer> {
    const session = this.sessions.get(token);
    if (!session?.info || session.closed) throw new Error('媒体预览已关闭');
    const count = mediaSegmentCount(session.info.duration);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('媒体片段不存在');
    if (session.requests >= policy.maxQueuedJobs) throw new Error('待加载的媒体片段过多');
    session.requests++;
    const version = ++session.requestVersion; session.lastRequestIndex = index;
    const superseded = () => version < session.requestVersion && Math.abs(index - session.lastRequestIndex) > policy.prefetchSegments;
    try {
      await this.unchanged(session);
      if (superseded()) throw new Error('媒体播放位置已改变');
      const cached = session.cache.get(index);
      if (cached) { if (session.worker) session.worker.want = Math.max(session.worker.want, index); this.changed(session); return cached; }
      let worker: Worker | undefined;
      for (;;) {
        if (superseded()) throw new Error('媒体播放位置已改变');
        worker = session.worker;
        if (!worker || (!worker.controller.signal.aborted && index >= worker.start && index >= worker.next && index <= worker.next + policy.prefetchSegments)) break;
        worker.controller.abort(); this.changed(session); await worker.task;
        // Re-read after awaiting: another seek may already own a new worker.
      }
      if (!worker) {
        if (session.closed) throw new Error('媒体预览已关闭');
        session.error = undefined;
        worker = { start: index, next: index, want: index, controller: new AbortController(), task: Promise.resolve() };
        session.worker = worker;
        const owned = worker;
        worker.task = this.produce(session, worker).catch((error: unknown) => {
          if (!owned.controller.signal.aborted && !session.closed) session.error = error instanceof Error ? error : new Error(String(error));
        }).finally(() => { if (session.worker === owned) session.worker = undefined; this.changed(session); });
      }
      const owned = worker; worker.want = Math.max(worker.want, index); this.changed(session);
      const deadline = Date.now() + policy.segmentTimeoutMs;
      for (;;) {
        if (superseded()) { owned.controller.abort(); this.changed(session); throw new Error('媒体播放位置已改变'); }
        const bytes = session.cache.get(index); if (bytes) return bytes;
        if (session.closed || owned.controller.signal.aborted) throw new Error('媒体预览已取消');
        if (session.error) throw session.error;
        if (session.worker !== owned) throw new Error('媒体文件没有所需的片段');
        const remaining = deadline - Date.now();
        if (remaining <= 0) { owned.controller.abort(); this.changed(session); throw new Error('媒体片段准备超时，请重试'); }
        await this.wait(session, remaining);
      }
    } finally { session.requests--; }
  }
  async close(token: string): Promise<void> {
    const session = this.sessions.get(token); if (!session) return;
    this.sessions.delete(token); session.closed = true; session.opening.abort(); session.worker?.controller.abort(); this.changed(session);
    await session.worker?.task; session.cache.clear(); session.bytes = 0;
  }
  async shutdown(): Promise<void> { await Promise.all([...this.sessions.keys()].map((token) => this.close(token))); }
}
