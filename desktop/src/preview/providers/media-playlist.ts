import policy from './media-policy.json';

export function mediaSegmentCount(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || duration > policy.maxDurationSeconds) throw new Error('媒体时长无法用于兼容播放');
  return Math.max(1, Math.ceil((duration - policy.mergeTailSeconds) / policy.segmentSeconds));
}
/** A continuous encoder retains its AAC state and a fixed source-time anchor.
 * The last URI also carries any sub-frame tail; no part of the source is cut. */
export function mediaPlaylist(duration: number): string {
  const count = mediaSegmentCount(duration);
  const target = Math.ceil(Math.max(policy.segmentSeconds, duration - (count - 1) * policy.segmentSeconds));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let index = 0; index < count; index++) {
    const seconds = index === count - 1 ? duration - index * policy.segmentSeconds : policy.segmentSeconds;
    lines.push(`#EXTINF:${seconds.toFixed(6)},`, `segments/${index}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
export interface MediaInfo { duration: number; videoIndex?: number; audioIndex?: number }
export function mediaProbeArguments(): string[] {
  return ['-v', 'error', '-protocol_whitelist', policy.inputProtocols, '-format_whitelist', policy.inputFormats, '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic', '-of', 'json', '-i', 'fd:'];
}
export function parseMediaInfo(value: unknown): MediaInfo {
  const data = value as { format?: { duration?: string }; streams?: { index?: number; codec_type?: string; duration?: string; disposition?: { attached_pic?: number } }[] };
  const streams = data?.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(data?.format?.duration ?? video?.duration ?? audio?.duration);
  mediaSegmentCount(duration);
  for (const stream of [video, audio]) if (stream && (!Number.isSafeInteger(stream.index) || stream.index! < 0)) throw new Error('媒体轨道无效');
  if (!video && !audio) throw new Error('文件没有可播放的音视频轨道');
  return { duration, videoIndex: video?.index, audioIndex: audio?.index };
}
export function mediaStreamArguments(index: number, info: MediaInfo, playlistPath: string): string[] {
  const { duration, videoIndex, audioIndex } = info;
  const count = mediaSegmentCount(duration);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('媒体片段位置无效');
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', policy.inputProtocols, '-format_whitelist', policy.inputFormats, '-ss', String(index * policy.segmentSeconds), '-i', 'fd:', '-sn', '-dn'];
  if (videoIndex !== undefined) args.push('-map', `0:${videoIndex}`, '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,setpts=PTS-STARTPTS', '-c:v', 'libopenh264', '-b:v', '1600k', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60');
  else args.push('-vn');
  if (audioIndex !== undefined) args.push('-map', `0:${audioIndex}`, '-af', 'asetpts=PTS-STARTPTS', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push('-avoid_negative_ts', 'disabled', '-output_ts_offset', String(index * policy.segmentSeconds + 1), '-f', 'hls', '-hls_time', String(policy.segmentSeconds), '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'single_file+independent_segments', '-hls_segment_options', 'mpegts_copyts=1', '-hls_segment_filename', 'pipe:1', playlistPath);
  return args;
}

export interface MediaByteRange { offset: number; size: number }
export function mediaByteRanges(playlist: string): MediaByteRange[] {
  if (playlist.length > policy.maxPlaylistBytes) throw new Error('媒体分段清单过大');
  let end = 0;
  return [...playlist.matchAll(/^#EXT-X-BYTERANGE:(\d+)@(\d+)\r?$/gm)].map((match) => {
    const size = Number(match[1]); const offset = Number(match[2]);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size <= 0 || size > policy.maxSegmentBytes || offset !== end) throw new Error('媒体分段清单无效');
    end += size; return { size, offset };
  });
}
