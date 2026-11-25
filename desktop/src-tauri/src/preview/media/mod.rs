//! Local, replaceable media compatibility service. No agent/runtime scheduler,
//! installed-codec discovery, shell commands or always-on server is involved.
mod engine;
mod policy;
mod process;
mod producer;
mod session;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::http::{Request, Response};
use engine::Engine;
use policy::{policy, segment_count, MediaInfo};
use process::{Control, Slot};
use session::{Session, Source, Worker};

#[derive(Default)]
struct Registry { sessions: HashMap<String, Arc<Session>>, early_cancels: VecDeque<String>, stopping: bool }
struct Inner { registry: Mutex<Registry>, engine: Engine, cache: PathBuf, slots: Arc<AtomicUsize>, requests: AtomicUsize }
#[derive(Clone)]
pub struct MediaState(Arc<Inner>);
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOpenResult { pub url: String, #[serde(flatten)] pub info: MediaInfo }
fn valid_token(token: &str) -> bool { (32..=64).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') }
impl MediaState {
    pub fn new(cache: PathBuf, engine: PathBuf) -> Self { Self(Arc::new(Inner { registry: Mutex::new(Registry::default()), engine: Engine::new(engine), cache, slots: Arc::new(AtomicUsize::new(0)), requests: AtomicUsize::new(0) })) }
    pub fn open(&self, token: &str, file_path: &str, allowed_root: &str, owner: &str) -> Result<MediaOpenResult, String> {
        if owner != "main" || !valid_token(token) { return Err("媒体预览请求无效".into()); }
        let session = {
            let mut registry = self.0.registry.lock().map_err(|_| "媒体状态不可用")?;
            if registry.stopping { return Err("应用正在关闭".into()); }
            if registry.sessions.contains_key(token) { return Err("媒体预览标识已在使用".into()); }
            if registry.sessions.len() >= policy().max_sessions { return Err("打开的媒体过多，请关闭部分预览".into()); }
            if registry.early_cancels.iter().any(|item| item == token) { registry.early_cancels.retain(|item| item != token); return Err("媒体预览已取消".into()); }
            let session = Arc::new(Session::new(owner.to_string())); registry.sessions.insert(token.to_owned(), Arc::clone(&session)); session
        };
        let result = (|| {
            session.opening.check()?;
            let _slot = Slot::acquire(&self.0.slots)?;
            let engine = self.0.engine.get()?; session.opening.check()?;
            let target = crate::commands::work_host::validate_target(file_path, allowed_root).map_err(|e| e.to_string())?;
            let source = Source::new(target)?; source.unchanged()?;
            let bytes = process::probe(&engine.probe, &policy::probe_arguments(), &source.target, &session.opening)?;
            let info = policy::parse_info(&bytes)?; session.opening.check()?;
            let playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
            if playback.closed { return Err("媒体预览已关闭".into()); }
            session.data.set((source, info.clone())).map_err(|_| "媒体预览重复初始化")?;
            let prefix = if cfg!(windows) { "http://trylo-media.localhost" } else { "trylo-media://localhost" };
            Ok(MediaOpenResult { url: format!("{prefix}/{token}/index.m3u8"), info })
        })();
        if result.is_err() { self.close(token, owner); } result
    }
    fn session(&self, token: &str, owner: &str) -> Result<Arc<Session>, String> {
        if owner != "main" { return Err("网页无权访问媒体预览".into()); }
        self.0.registry.lock().map_err(|_| "媒体状态不可用")?.sessions.get(token).filter(|session| session.owner == owner).cloned().ok_or_else(|| "媒体预览已关闭".into())
    }
    pub fn close(&self, token: &str, owner: &str) {
        if owner != "main" || !valid_token(token) { return; }
        let session = {
            let Ok(mut registry) = self.0.registry.lock() else { return; };
            let session = registry.sessions.remove(token);
            if session.is_none() && !registry.early_cancels.iter().any(|item| item == token) {
                if registry.early_cancels.len() >= 128 { registry.early_cancels.pop_front(); }
                registry.early_cancels.push_back(token.to_string());
            }
            session
        };
        if let Some(session) = session { session.close(); }
    }
    pub fn shutdown(&self) -> usize {
        let sessions = {
            let Ok(mut registry) = self.0.registry.lock() else { return 0; };
            registry.stopping = true; registry.sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()
        };
        let count = sessions.len(); for session in sessions { session.close(); } count
    }
    fn start(&self, session: &Arc<Session>, index: usize, playback: &mut session::Playback) -> u64 {
        playback.generation += 1; let generation = playback.generation;
        let control = Arc::new(Control::default()); playback.error = None;
        playback.worker = Some(Worker { generation, start: index, next: index, want: index, control: Arc::clone(&control) });
        let inner = Arc::clone(&self.0); let session = Arc::clone(session);
        std::thread::spawn(move || {
            let result = producer::produce(&session, generation, index, &control, &inner.engine, &inner.slots, &inner.cache);
            if let Ok(mut playback) = session.playback.lock() {
                if playback.worker.as_ref().is_some_and(|worker| worker.generation == generation) {
                    if let Err(error) = result { if control.check().is_ok() && !playback.closed { playback.error = Some(error); } }
                    playback.worker = None;
                }
            }
            session.changed.notify_all();
        });
        generation
    }
    pub fn segment(&self, token: &str, index: usize, owner: &str) -> Result<Arc<Vec<u8>>, String> {
        struct RequestCount<'a>(&'a AtomicUsize);
        impl Drop for RequestCount<'_> { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); } }

        let session = self.session(token, owner)?; let count = segment_count(session.info()?.duration)?;
        if index >= count { return Err("媒体片段不存在".into()); }
        self.0.requests.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| (count < policy().max_queued_jobs).then_some(count + 1)).map_err(|_| "待加载的媒体片段过多")?;
        let _request = RequestCount(&self.0.requests);
        let version = {
            let mut playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
            playback.request_version += 1; playback.last_request_index = index; playback.request_version
        };
        let superseded = |playback: &session::Playback| version < playback.request_version && index.abs_diff(playback.last_request_index) > policy().prefetch_segments;
        session.source()?.unchanged()?;
        let deadline = Instant::now() + Duration::from_millis(policy().segment_timeout_ms);
        let mut playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
        let generation = loop {
            if playback.closed { return Err("媒体预览已关闭".into()); }
            if superseded(&playback) { return Err("媒体播放位置已改变".into()); }
            if let Some(bytes) = playback.cached(index) { session.changed.notify_all(); return Ok(bytes); }
            if let Some(worker) = &playback.worker {
                if worker.control.check().is_err() || index < worker.start || index < worker.next || index > worker.next + policy().prefetch_segments {
                    let previous_generation = worker.generation;
                    let control = Arc::clone(&worker.control); drop(playback); control.stop(); session.changed.notify_all();
                    playback = session.playback.lock().map_err(|_| "媒体状态不可用")?;
                    while playback.worker.as_ref().is_some_and(|worker| worker.generation == previous_generation) {
                        let remaining = deadline.checked_duration_since(Instant::now()).ok_or("媒体位置切换超时")?;
                        playback = session.changed.wait_timeout(playback, remaining).map_err(|_| "媒体状态不可用")?.0;
                    }
                    continue;
                }
            }
            if let Some(worker) = &mut playback.worker { worker.want = worker.want.max(index); break worker.generation; }
            break self.start(&session, index, &mut playback);
        };
        session.changed.notify_all();
        loop {
            if superseded(&playback) {
                let control = playback.worker.as_ref().filter(|worker| worker.generation == generation).map(|worker| Arc::clone(&worker.control));
                drop(playback); if let Some(control) = control { control.stop(); } session.changed.notify_all(); return Err("媒体播放位置已改变".into());
            }
            if let Some(bytes) = playback.cached(index) { session.changed.notify_all(); return Ok(bytes); }
            if playback.closed { return Err("媒体预览已关闭".into()); }
            if playback.generation != generation { return Err("媒体播放位置已改变".into()); }
            if let Some(error) = &playback.error { return Err(error.clone()); }
            let worker = playback.worker.as_ref().ok_or("媒体文件没有所需的片段")?;
            worker.control.check()?;
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                let control = Arc::clone(&worker.control); drop(playback); control.stop(); session.changed.notify_all(); return Err("媒体片段准备超时，请重试".into());
            };
            playback = session.changed.wait_timeout(playback, remaining).map_err(|_| "媒体状态不可用")?.0;
        }
    }
    pub fn serve(&self, request: &Request<Vec<u8>>, owner: &str) -> Response<Vec<u8>> {
        let result = (|| {
            if owner != "main" { return Err((403, "网页无权访问媒体预览".to_string())); }
            if request.method() != "GET" && request.method() != "HEAD" { return Err((405, "请求方式无效".into())); }
            let parts: Vec<_> = request.uri().path().trim_start_matches('/').split('/').collect();
            if parts.len() < 2 || !valid_token(parts[0]) { return Err((404, "媒体预览不存在".into())); }
            let session = self.session(parts[0], owner).map_err(|error| (404, error))?;
            if parts.len() == 2 && parts[1] == "index.m3u8" {
                return Ok(("application/vnd.apple.mpegurl", policy::playlist(session.info().map_err(|error| (422, error))?).map_err(|error| (422, error))?));
            }
            if parts.len() == 3 && parts[1] == "segments" {
                let index = parts[2].strip_suffix(".ts").filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())).and_then(|text| text.parse::<usize>().ok()).ok_or((404, "媒体片段不存在".into()))?;
                return self.segment(parts[0], index, owner).map(|bytes| ("video/mp2t", bytes.as_ref().clone())).map_err(|error| (422, error));
            }
            Err((404, "媒体资源不存在".into()))
        })();
        let (status, mime, bytes) = match result { Ok((mime, bytes)) => (200, mime, bytes), Err((status, error)) => (status, "text/plain; charset=utf-8", error.into_bytes()) };
        Response::builder().status(status).header("Content-Type", mime).header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "*").header("X-Content-Type-Options", "nosniff").body(if request.method() == "HEAD" { vec![] } else { bytes }).expect("static media response headers")
    }
}
