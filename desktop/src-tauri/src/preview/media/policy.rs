use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub segment_seconds: f64, pub max_duration_seconds: f64, pub max_segment_bytes: usize,
    pub max_probe_bytes: usize, pub max_playlist_bytes: u64, pub prefetch_segments: usize,
    pub merge_tail_seconds: f64, pub max_concurrent_jobs: usize, pub max_queued_jobs: usize,
    pub max_sessions: usize, pub max_cache_bytes: usize, pub probe_timeout_ms: u64,
    pub segment_timeout_ms: u64, pub input_protocols: String, pub input_formats: String,
}
pub fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(include_str!("../../../../src/preview/providers/media-policy.json")).expect("compiled media policy"))
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_index: Option<u64>,
}
// The compiled duration policy caps this conversion at 100,800 segments.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn segment_count(duration: f64) -> Result<usize, String> {
    if !duration.is_finite() || duration <= 0.0 || duration > policy().max_duration_seconds { return Err("媒体时长无法用于兼容播放".into()); }
    Ok((((duration - policy().merge_tail_seconds) / policy().segment_seconds).ceil() as usize).max(1))
}
pub fn parse_info(bytes: &[u8]) -> Result<MediaInfo, String> {
    let data: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "无法读取媒体轨道信息")?;
    let streams = data["streams"].as_array().ok_or("媒体没有轨道信息")?;
    let video = streams.iter().find(|stream| stream["codec_type"] == "video" && stream["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 0);
    let audio = streams.iter().find(|stream| stream["codec_type"] == "audio");
    let duration = data["format"]["duration"].as_str().or_else(|| video.and_then(|stream| stream["duration"].as_str())).or_else(|| audio.and_then(|stream| stream["duration"].as_str())).and_then(|value| value.parse::<f64>().ok()).ok_or("媒体时长不可用")?;
    segment_count(duration)?;
    if video.is_none() && audio.is_none() { return Err("文件没有可播放的音视频轨道".into()); }
    let index = |stream: Option<&serde_json::Value>| -> Result<Option<u64>, String> {
        stream.map(|stream| stream["index"].as_u64().filter(|index| *index < 1024).ok_or_else(|| "媒体轨道无效".to_string())).transpose()
    };
    Ok(MediaInfo { duration, video_index: index(video)?, audio_index: index(audio)? })
}
fn strings(parts: &[&str]) -> Vec<String> { parts.iter().map(|part| (*part).to_string()).collect() }
pub fn probe_arguments() -> Vec<String> {
    let mut args = strings(&["-v", "error", "-protocol_whitelist", &policy().input_protocols, "-format_whitelist", &policy().input_formats]);
    args.extend(strings(&["-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic", "-of", "json", "-i", "fd:"])); args
}
// Segment indices accepted from the protocol are bounded by segment_count.
#[allow(clippy::cast_precision_loss)]
fn segment_start(index: usize) -> f64 { index as f64 * policy().segment_seconds }

pub fn stream_arguments(index: usize, info: &MediaInfo, playlist: &std::path::Path) -> Vec<String> {
    let start = segment_start(index);
    let mut args = strings(&["-hide_banner", "-v", "error", "-nostdin", "-protocol_whitelist", &policy().input_protocols, "-format_whitelist", &policy().input_formats, "-ss", &start.to_string(), "-i", "fd:", "-sn", "-dn"]);
    if let Some(track) = info.video_index {
        args.extend(strings(&["-map", &format!("0:{track}"), "-vf", "scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,setpts=PTS-STARTPTS"]));
        if cfg!(target_os = "macos") {
            args.extend(strings(&["-c:v", "h264_videotoolbox", "-allow_sw", "1"]));
        } else {
            args.extend(strings(&["-c:v", "libopenh264"]));
        }
        args.extend(strings(&["-b:v", "1600k", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60"]));
    } else { args.push("-vn".into()); }
    if let Some(track) = info.audio_index {
        args.extend(strings(&["-map", &format!("0:{track}"), "-af", "asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]));
    } else { args.push("-an".into()); }
    args.extend(strings(&["-avoid_negative_ts", "disabled", "-output_ts_offset", &(start + 1.0).to_string(), "-f", "hls", "-hls_time", &policy().segment_seconds.to_string(), "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_flags", "single_file+independent_segments", "-hls_segment_options", "mpegts_copyts=1", "-hls_segment_filename", "pipe:1", &playlist.to_string_lossy()])); args
}
pub fn playlist(info: &MediaInfo) -> Result<Vec<u8>, String> {
    use std::fmt::Write;
    let count = segment_count(info.duration)?;
    let target = policy().segment_seconds.max(info.duration - segment_start(count - 1)).ceil();
    let mut text = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    for index in 0..count {
        let seconds = if index == count - 1 { info.duration - segment_start(index) } else { policy().segment_seconds };
        let _ = writeln!(text, "#EXTINF:{seconds:.6},\nsegments/{index}.ts");
    }
    text.push_str("#EXT-X-ENDLIST\n"); Ok(text.into_bytes())
}
#[derive(Debug)]
pub struct ByteRange { pub offset: u64, pub size: usize }
pub fn byte_ranges(text: &str) -> Result<Vec<ByteRange>, String> {
    if text.len() as u64 > policy().max_playlist_bytes { return Err("媒体分段清单过大".into()); }
    let mut result = Vec::new(); let mut end = 0;
    for line in text.lines() {
        let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") else { continue; };
        let (size, offset) = value.split_once('@').ok_or("媒体分段清单无效")?;
        let size = size.parse::<usize>().map_err(|_| "媒体分段大小无效")?;
        let offset = offset.parse::<u64>().map_err(|_| "媒体分段偏移无效")?;
        if size == 0 || size > policy().max_segment_bytes || offset != end { return Err("媒体分段清单无效".into()); }
        end = offset.checked_add(size as u64).ok_or("媒体分段偏移溢出")?;
        result.push(ByteRange { offset, size });
    }
    Ok(result)
}
