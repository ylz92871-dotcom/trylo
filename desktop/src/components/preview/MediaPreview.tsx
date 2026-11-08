import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AudioLines, Play } from 'lucide-react';
import { openCompatibleMedia, openPreviewMedia } from '../../host-adapter/preview/media';
import { attachMediaPlayback } from './media-playback';
import { PreviewFailure } from './PreviewFailure';
import { MediaTransport, mediaTime } from './MediaTransport';

const initialSnapshot = { time: 0, duration: Number.NaN, paused: true, buffering: false };
export function MediaPreview({ path, allowedRoot, kind }: { path: string; allowedRoot?: string; kind: 'audio' | 'video' }): ReactElement {
  const key = `${allowedRoot ?? ''}\0${path}`;
  const [mode, setMode] = useState({ key: '', compatible: false });
  const compatible = mode.key === key && mode.compatible;
  const [source, setSource] = useState({ key: '', url: '', error: '' });
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const [rate, setRate] = useState(1), [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(1), [muted, setMuted] = useState(false);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [fullscreen, setFullscreen] = useState(false), [notice, setNotice] = useState('');
  const root = useRef<HTMLDivElement>(null), media = useRef<HTMLMediaElement | null>(null);
  const bindMedia = useCallback((element: HTMLMediaElement | null) => { media.current = element; }, []);
  const resume = useRef({ key: '', seconds: 0, playing: false });
  const stopPlayback = useRef<() => void>(() => {});
  useEffect(() => {
    let stale = false, release: (() => void) | undefined, detach: (() => void) | undefined;
    const controller = new AbortController();
    setLoading(true); setSource({ key: '', url: '', error: '' }); setSnapshot(initialSnapshot); setNotice('');
    const element = media.current;
    const close = (): void => {
      if (stale) return;
      stale = true; controller.abort(); detach?.();
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
      release?.();
    };
    stopPlayback.current = close;
    const fail = (error: unknown): void => {
      if (stale) return;
      close(); setLoading(false); setSource({ key, url: '', error: error instanceof Error ? error.message : String(error) });
    };
    if (!allowedRoot) { fail('请先打开文件所在的项目。'); return close; }
    const opening = compatible ? openCompatibleMedia(path, allowedRoot, controller.signal) : openPreviewMedia(path, allowedRoot);
    void opening.then(async result => {
      if (stale) { result.release(); return; }
      release = result.release; setSource({ key, url: result.url, error: '' });
      if (!element) return;
      try { const cleanup = await attachMediaPlayback(element, result, controller.signal, fail); if (stale) cleanup(); else detach = cleanup; }
      catch (error) { fail(error); }
    }, fail);
    return close;
  }, [path, allowedRoot, kind, key, compatible, revision]);
  useEffect(() => {
    const changed = (): void => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const current = source.key === key ? source : { url: '', error: '' };
  const pending = loading || source.key !== key;
  const ready = !pending && !!current.url && !current.error;
  const update = (buffering = false): void => {
    const element = media.current;
    if (element) setSnapshot({ time: element.currentTime, duration: element.duration, paused: element.paused, buffering: buffering && !element.paused });
  };
  const seek = (seconds: number): void => {
    const element = media.current;
    if (element && Number.isFinite(element.duration)) { element.currentTime = Math.max(0, Math.min(element.duration, seconds)); update(); }
  };
  const play = (): void => {
    const element = media.current;
    if (!ready || !element) return;
    if (element.paused) void element.play().catch((error: unknown) => { if (error instanceof Error && (error.name === 'AbortError' || error.name === 'NotSupportedError')) return; if (media.current === element && element.isConnected) setNotice('播放未能开始，请重试或切换兼容播放。'); });
    else element.pause();
  };
  const useCompatibility = (): void => {
    const element = media.current;
    resume.current = { key, seconds: element?.currentTime ?? 0, playing: element ? !element.paused : false };
    setMode({ key, compatible: true });
  };
  const toggleMute = (): void => { if (media.current) { media.current.muted = !media.current.muted; setMuted(media.current.muted); } };
  const toggleFullscreen = async (): Promise<void> => {
    try { if (document.fullscreenElement === root.current) await document.exitFullscreen(); else await root.current?.requestFullscreen(); }
    catch { setNotice('无法进入全屏，请使用顶部的展开预览。'); }
  };
  const shared = {
    controls: false, preload: 'metadata', loop, muted, ref: bindMedia,
    onLoadedMetadata: () => {
      const element = media.current;
      if (element) {
        element.playbackRate = rate;
        if (resume.current.key === key) {
          if (resume.current.seconds > 0 && Number.isFinite(element.duration)) element.currentTime = Math.min(resume.current.seconds, element.duration);
          if (resume.current.playing) void element.play().catch(() => {});
          resume.current = { key: '', seconds: 0, playing: false };
        }
      }
      setLoading(false); update();
    },
    onTimeUpdate: () => update(), onDurationChange: () => update(), onPlay: () => update(), onPause: () => update(),
    onPlaying: () => update(), onCanPlay: () => update(), onSeeked: () => update(), onWaiting: () => update(true), onEnded: () => update(),
    onVolumeChange: () => { if (media.current) { setMuted(media.current.muted); setVolume(media.current.volume); } },
    onError: () => {
      if (!current.url) return;
      if (!compatible) useCompatibility();
      else { stopPlayback.current(); setLoading(false); setSource({ key, url: '', error: '兼容播放失败，请重新加载预览。文件可能损坏，或编码暂不支持。' }); }
    },
  };
  return <div ref={root} className={`media-reader media-reader--${kind}`} role="region" tabIndex={0} aria-label={kind === 'video' ? '视频预览' : '音频预览'} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('input,select,button') || !ready) return;
    if (event.code === 'Space') { event.preventDefault(); play(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(snapshot.time + (event.key === 'ArrowRight' ? 10 : -10)); }
    if (event.key.toLowerCase() === 'm') toggleMute();
  }}>
    <div className="media-reader__stage">
      {kind === 'video' ? <video {...shared} onClick={play} playsInline hidden={!!current.error} /> : <><audio {...shared} /><div className="media-reader__audio-info" hidden={!!current.error}><span className="media-reader__audio-mark"><AudioLines size={30} strokeWidth={1.4} /></span><strong title={path}>{path.replace(/\\/g, '/').split('/').at(-1)}</strong><span>{Number.isFinite(snapshot.duration) ? mediaTime(snapshot.duration) + ' · ' : ''}音频</span></div></>}
      {current.error ? <div className="media-reader__error"><PreviewFailure error={current.error}><button type="button" onClick={() => setRevision(value => value + 1)}>重试播放</button><p>也可以使用文件操作中的外部打开。</p></PreviewFailure></div>
        : pending || snapshot.buffering ? <div className="media-reader__loading" role="status"><span className="preview__spinner" />{pending ? compatible ? '正在准备兼容播放…' : '正在读取媒体信息…' : '正在缓冲…'}</div>
        : kind === 'video' && snapshot.paused && ready && <button type="button" className="media-reader__center-play" aria-label="开始播放视频" onClick={play}><Play size={23} fill="currentColor" /></button>}
    </div>
    {notice && <p className="media-reader__notice" role="status">{notice}</p>}
    <MediaTransport ready={ready} playing={!snapshot.paused} time={source.key === key ? snapshot.time : 0} duration={source.key === key ? snapshot.duration : Number.NaN}
      rate={rate} loop={loop} volume={volume} muted={muted} compatible={compatible} video={kind === 'video'} fullscreen={fullscreen}
      onPlay={play} onSeek={seek} onRate={value => { setRate(value); if (media.current) media.current.playbackRate = value; }} onLoop={() => setLoop(value => !value)}
      onMute={toggleMute} onVolume={value => { if (media.current) { media.current.volume = value; media.current.muted = value === 0; setVolume(value); setMuted(value === 0); } }}
      onCompatible={useCompatibility} onFullscreen={() => void toggleFullscreen()} />
  </div>;
}
