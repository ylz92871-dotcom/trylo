use std::path::Path;
use std::sync::{atomic::AtomicUsize, mpsc, Arc};
use std::time::{Duration, Instant};
use super::{engine::Engine, policy::{byte_ranges, policy, segment_count, stream_arguments}, process::{Control, MediaProcess, Slot}, session::{Scratch, Session}};

struct Pending { bytes: Vec<u8>, consumed: u64, range: usize }
impl Pending {
    fn publish(&mut self, session: &Session, generation: u64, start: usize, playlist: &Path, finished: bool) -> Result<(), String> {
        let Ok(meta) = std::fs::metadata(playlist) else { return Ok(()); };
        if meta.len() > policy().max_playlist_bytes { return Err("媒体分段清单过大".into()); }
        let text = std::fs::read_to_string(playlist).map_err(|e| e.to_string())?;
        let ranges = byte_ranges(&text)?;
        let count = segment_count(session.info()?.duration)?;
        while self.range < ranges.len() {
            let range = &ranges[self.range]; let index = start + self.range;
            if range.offset != self.consumed { return Err("媒体片段偏移无效".into()); }
            let size = if index == count - 1 {
                if !finished { break; }
                let size: usize = ranges[self.range..].iter().map(|range| range.size).sum();
                if size != self.bytes.len() { return Err("媒体尾段不完整".into()); } size
            } else {
                if index >= count { return Err("媒体实际时长与轨道信息不一致".into()); }
                if self.bytes.len() < range.size { break; } range.size
            };
            let tail = self.bytes.split_off(size); let bytes = std::mem::replace(&mut self.bytes, tail);
            let mut playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
            if playback.closed || !playback.worker.as_ref().is_some_and(|worker| worker.generation == generation) { return Err("媒体预览已取消".into()); }
            playback.store(index, bytes)?;
            playback.worker.as_mut().ok_or("媒体播放作业已结束")?.next = index + 1;
            self.consumed += size as u64; self.range = if index == count - 1 { ranges.len() } else { self.range + 1 };
            drop(playback); session.changed.notify_all();
        }
        Ok(())
    }
}
/// One encoder preserves its audio state over all forward segments. Reading is
/// paused once enough pieces are buffered, so the pipe bounds CPU and memory.
pub fn produce(session: &Session, generation: u64, start: usize, control: &Arc<Control>, engine: &Engine, slots: &Arc<AtomicUsize>, cache: &Path) -> Result<(), String> {
    let _slot = Slot::acquire(slots)?; control.check()?;
    let executables = engine.get()?; let scratch = Scratch::create(cache)?;
    session.source()?.unchanged()?; control.check()?;
    let mut process = MediaProcess::spawn(&executables.encoder, &stream_arguments(start, session.info()?, &scratch.playlist), &session.source()?.target, Some(&scratch.directory), Arc::clone(control))?;
    let output = process.output.take().ok_or("媒体输出流不可用")?;
    let mut pending = Pending { bytes: Vec::new(), consumed: 0, range: 0 };
    let count = segment_count(session.info()?.duration)?;
    let timeout = Duration::from_millis(policy().segment_timeout_ms);
    let mut progress = Instant::now();
    loop {
        control.check()?;
        if progress.elapsed() >= timeout { return Err("媒体片段准备超时，请重试".into()); }
        match output.recv_timeout(Duration::from_millis(30)) {
            Ok(Ok(bytes)) => {
                progress = Instant::now();
                if pending.bytes.len() + bytes.len() > policy().max_segment_bytes { return Err("媒体片段超过 16 MB 限制".into()); }
                pending.bytes.extend(bytes); pending.publish(session, generation, start, &scratch.playlist, false)?;
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => { pending.publish(session, generation, start, &scratch.playlist, false)?; }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let mut playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
        let idle = Instant::now();
        loop {
            control.check()?;
            let worker = playback.worker.as_ref().filter(|worker| worker.generation == generation).ok_or("媒体播放位置已改变")?;
            if worker.next <= worker.want + policy().prefetch_segments || worker.next >= count { break; }
            let Some(remaining) = timeout.checked_sub(idle.elapsed()) else { return Ok(()); };
            playback = session.changed.wait_timeout(playback, remaining).map_err(|_| "媒体状态不可用")?.0;
            progress = Instant::now();
        }
    }
    process.finish(Instant::now() + Duration::from_secs(3))?;
    pending.publish(session, generation, start, &scratch.playlist, true)?;
    let playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
    let next = playback.worker.as_ref().filter(|worker| worker.generation == generation).map_or(0, |worker| worker.next);
    if next < count || !pending.bytes.is_empty() { return Err("媒体文件在预期结束位置之前中断".into()); }
    Ok(())
}
