use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::SystemTime;
use super::{policy::{policy, MediaInfo}, process::Control};

pub struct Source { pub target: PathBuf, size: u64, modified: Option<SystemTime> }
impl Source {
    pub fn new(target: PathBuf) -> Result<Self, String> {
        let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err("媒体路径不是文件".into()); }
        Ok(Self { target, size: meta.len(), modified: meta.modified().ok() })
    }
    pub fn unchanged(&self) -> Result<(), String> {
        let canonical = std::fs::canonicalize(&self.target).map_err(|_| "媒体文件不可用")?;
        let meta = std::fs::metadata(&self.target).map_err(|_| "媒体文件不可用")?;
        if canonical != self.target || !meta.is_file() || meta.len() != self.size || meta.modified().ok() != self.modified { return Err("文件已更新，请重新加载预览".into()); }
        Ok(())
    }
}
pub struct Worker { pub generation: u64, pub start: usize, pub next: usize, pub want: usize, pub control: Arc<Control> }
#[derive(Default)]
pub struct Playback {
    pub closed: bool, pub generation: u64, pub worker: Option<Worker>, pub error: Option<String>,
    pub request_version: u64, pub last_request_index: usize,
    cache: BTreeMap<usize, Arc<Vec<u8>>>, order: VecDeque<usize>, bytes: usize,
}
impl Playback {
    pub fn cached(&mut self, index: usize) -> Option<Arc<Vec<u8>>> {
        let bytes = self.cache.get(&index)?.clone();
        self.order.retain(|item| *item != index); self.order.push_back(index);
        if let Some(worker) = &mut self.worker { worker.want = worker.want.max(index); }
        Some(bytes)
    }
    pub fn store(&mut self, index: usize, bytes: Vec<u8>) -> Result<(), String> {
        let limit = policy().max_cache_bytes / policy().max_sessions;
        if bytes.len() > limit { return Err("媒体片段超过缓存限制".into()); }
        if let Some(previous) = self.cache.remove(&index) { self.bytes -= previous.len(); self.order.retain(|item| *item != index); }
        while self.bytes + bytes.len() > limit {
            let oldest = self.order.pop_front().ok_or("媒体缓存索引无效")?;
            if let Some(previous) = self.cache.remove(&oldest) { self.bytes -= previous.len(); }
        }
        self.bytes += bytes.len(); self.order.push_back(index); self.cache.insert(index, Arc::new(bytes)); Ok(())
    }
    pub fn clear(&mut self) { self.cache.clear(); self.order.clear(); self.bytes = 0; }
}
pub struct Session {
    pub owner: String, pub opening: Arc<Control>, pub data: OnceLock<(Source, MediaInfo)>,
    pub playback: Mutex<Playback>, pub changed: Condvar,
}
impl Session {
    pub fn new(owner: String) -> Self { Self { owner, opening: Arc::new(Control::default()), data: OnceLock::new(), playback: Mutex::new(Playback::default()), changed: Condvar::new() } }
    pub fn close(&self) {
        let control = if let Ok(mut playback) = self.playback.lock() {
            playback.closed = true; playback.clear(); playback.worker.as_ref().map(|worker| Arc::clone(&worker.control))
        } else { None };
        self.opening.stop(); if let Some(control) = control { control.stop(); } self.changed.notify_all();
    }
    pub fn source(&self) -> Result<&Source, String> { self.data.get().map(|(source, _)| source).ok_or_else(|| "媒体预览尚未准备".into()) }
    pub fn info(&self) -> Result<&MediaInfo, String> { self.data.get().map(|(_, info)| info).ok_or_else(|| "媒体预览尚未准备".into()) }
}

/// Every scratch directory is created exclusively by one worker. Cleanup only
/// removes its two known playlist files and the empty directory, never a tree.
pub struct Scratch { pub directory: PathBuf, pub playlist: PathBuf }
impl Scratch {
    pub fn create(root: &Path) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let nonce = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let directory = root.join(format!("stream-{}-{nonce}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        Ok(Self { playlist: directory.join("stream.m3u8"), directory })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.playlist);
        let _ = std::fs::remove_file(self.directory.join("stream.m3u8.tmp"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}
