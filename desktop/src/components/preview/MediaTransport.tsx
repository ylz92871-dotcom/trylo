import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Ellipsis, Maximize, Minimize, Pause, Play, Repeat2, Volume2, VolumeX } from 'lucide-react';
export function mediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—:—';
  const value = Math.floor(seconds), h = Math.floor(value / 3600), m = Math.floor(value / 60) % 60, s = value % 60;
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}
export function MediaTransport({ ready, playing, time, duration, rate, loop, muted, volume, compatible, video, fullscreen,
  onPlay, onSeek, onRate, onLoop, onMute, onVolume, onCompatible, onFullscreen }: {
  ready: boolean; playing: boolean; time: number; duration: number; rate: number; loop: boolean; muted: boolean; volume: number;
  compatible: boolean; video: boolean; fullscreen: boolean;
  onPlay: () => void; onSeek: (seconds: number) => void; onRate: (rate: number) => void; onLoop: () => void;
  onMute: () => void; onVolume: (volume: number) => void; onCompatible: () => void; onFullscreen: () => void;
}): ReactElement {
  const [options, setOptions] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!options) return;
    const dismiss = (event: PointerEvent): void => { if (!menu.current?.contains(event.target as Node)) setOptions(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [options]);
  const seekable = ready && Number.isFinite(duration) && duration > 0;
  const percent = seekable ? Math.max(0, Math.min(100, time / duration * 100)) : 0;
  return <div className="media-reader__transport">
    <input className="media-reader__timeline" type="range" aria-label="播放进度" aria-valuetext={`${mediaTime(time)} / ${mediaTime(duration)}`}
      min={0} max={seekable ? duration : 0} step={.1} value={seekable ? Math.min(time, duration) : 0} disabled={!seekable}
      style={{ background: `linear-gradient(to right, var(--media-progress) ${percent}%, var(--media-track) ${percent}%)` }} onChange={event => onSeek(Number(event.target.value))} />
    <div className="media-reader__buttons" role="toolbar" aria-label="媒体播放控制">
      <button type="button" className="media-reader__play" aria-label={playing ? '暂停' : '播放'} title={playing ? '暂停 · 空格' : '播放 · 空格'} disabled={!ready} onClick={onPlay}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      <span className="media-reader__time">{mediaTime(time)}<span> / {mediaTime(duration)}</span></span>
      <span className="media-reader__spacer" />
      <button type="button" aria-label={muted ? '取消静音' : '静音'} title={muted ? '取消静音' : '静音'} onClick={onMute}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <select aria-label="播放速度" title="播放速度" value={rate} onChange={event => onRate(Number(event.target.value))}>{[.5,.75,1,1.25,1.5,2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
      <div ref={menu} className="media-reader__options-anchor" onKeyDown={event => { if (event.key === 'Escape' && options) { event.stopPropagation(); setOptions(false); menu.current?.querySelector('button')?.focus(); } }}>
        <button type="button" aria-label="播放选项" title="播放选项" aria-expanded={options} onClick={() => setOptions(value => !value)}><Ellipsis size={17} /></button>
        {options && <div className="media-reader__options" aria-label="播放设置">
          <button type="button" disabled={!seekable} onClick={() => onSeek(time - 10)}>后退 10 秒</button>
          <button type="button" disabled={!seekable} onClick={() => onSeek(time + 10)}>前进 10 秒</button>
          <button type="button" aria-pressed={loop} onClick={onLoop}><Repeat2 size={14} />循环播放<span>{loop ? '开' : '关'}</span></button>
          <label>音量 <input type="range" aria-label="音量" min={0} max={1} step={.05} value={volume} onChange={event => onVolume(Number(event.target.value))} /></label>
          <button type="button" onClick={() => { onCompatible(); setOptions(false); }} disabled={compatible}>兼容播放{compatible && <span>已启用</span>}</button>
        </div>}
      </div>
      {video && <button type="button" aria-label={fullscreen ? '退出视频全屏' : '视频全屏'} title={fullscreen ? '退出全屏' : '全屏'} disabled={!ready} onClick={onFullscreen}>{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>}
    </div>
  </div>;
}
