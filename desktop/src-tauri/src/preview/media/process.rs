use crate::commands::process_termination::OwnedTreeTerminator;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc::{self, Receiver}, Arc, Mutex};
use std::time::{Duration, Instant};
use super::policy::policy;

#[derive(Default)]
pub struct Control { cancelled: AtomicBool, process: Mutex<Option<OwnedTreeTerminator>> }
impl Control {
    pub fn check(&self) -> Result<(), String> { if self.cancelled.load(Ordering::Acquire) { Err("媒体预览已取消".into()) } else { Ok(()) } }
    pub fn stop(&self) {
        if self.cancelled.swap(true, Ordering::AcqRel) { return; }
        let tree = self.process.lock().ok().and_then(|process| process.clone());
        if let Some(tree) = tree { if let Err(error) = tree.terminate() { eprintln!("[media-preview] owned process stop failed: {error}"); } }
    }
    fn attach(&self, tree: OwnedTreeTerminator) -> Result<(), String> {
        let mut process = self.process.lock().map_err(|_| "媒体进程状态不可用")?;
        self.check()?; *process = Some(tree); Ok(())
    }
}
pub(super) fn increment_below(counter: &AtomicUsize, limit: usize) -> bool {
    let mut count = counter.load(Ordering::Acquire);
    loop {
        if count >= limit {
            return false;
        }
        match counter.compare_exchange_weak(count, count + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => count = actual,
        }
    }
}

pub struct Slot(Arc<AtomicUsize>);
impl Slot {
    pub fn acquire(slots: &Arc<AtomicUsize>) -> Result<Self, String> {
        if !increment_below(slots, policy().max_concurrent_jobs) {
            return Err("媒体兼容引擎繁忙，请稍后重试".into());
        }
        Ok(Self(Arc::clone(slots)))
    }
}
impl Drop for Slot { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); } }

/// A console child, its retained Windows process identity and bounded readers.
/// The stdout pipe supplies backpressure while playback has enough segments.
pub struct MediaProcess {
    child: Child, pub output: Option<Receiver<Result<Vec<u8>, String>>>,
    diagnostic: Arc<Mutex<Vec<u8>>>, control: Arc<Control>,
}
impl MediaProcess {
    pub fn spawn(executable: &Path, args: &[String], source: &Path, cwd: Option<&Path>, control: Arc<Control>) -> Result<Self, String> {
        control.check()?;
        let input = std::fs::File::open(source).map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command.args(args).stdin(Stdio::from(input)).stdout(Stdio::piped()).stderr(Stdio::piped()).env_remove("FFREPORT");
        if let Some(cwd) = cwd { command.current_dir(cwd); }
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
        let (mut child, tree) = OwnedTreeTerminator::spawn(&mut command).map_err(|e| format!("媒体引擎启动失败：{e}"))?;
        let attached = control.attach(tree);
        if let Err(error) = attached { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        let mut stdout = child.stdout.take().ok_or("媒体进程没有输出流")?;
        let mut stderr = child.stderr.take().ok_or("媒体进程没有诊断流")?;
        let (sender, output) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut buffer = vec![0; 64 * 1024];
            loop { match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => if sender.send(Ok(buffer[..size].to_vec())).is_err() { break; },
                Err(error) => { let _ = sender.send(Err(error.to_string())); break; }
            } }
        });
        let diagnostic = Arc::new(Mutex::new(Vec::new())); let recorded = Arc::clone(&diagnostic);
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(size) = stderr.read(&mut buffer) {
                if size == 0 { break; }
                if let Ok(mut bytes) = recorded.lock() { let keep = size.min(8192_usize.saturating_sub(bytes.len())); bytes.extend_from_slice(&buffer[..keep]); }
            }
        });
        Ok(Self { child, output: Some(output), diagnostic, control })
    }
    pub fn finish(&mut self, deadline: Instant) -> Result<(), String> {
        loop {
            self.control.check()?;
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                if status.success() { return Ok(()); }
                let diagnostic = self.diagnostic.lock().map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
                return Err(if diagnostic.is_empty() { "媒体转换失败".into() } else { diagnostic });
            }
            if Instant::now() >= deadline { return Err("媒体引擎结束超时".into()); }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for MediaProcess {
    fn drop(&mut self) {
        // FFmpeg does not spawn other executables. Child::kill addresses the
        // retained process object even if a concurrent cancel already reaped it.
        if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); }
        self.output.take(); let _ = self.child.wait();
        if let Ok(mut process) = self.control.process.lock() { *process = None; }
    }
}
pub fn probe(executable: &Path, args: &[String], source: &Path, control: &Arc<Control>) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_millis(policy().probe_timeout_ms);
    let mut process = MediaProcess::spawn(executable, args, source, None, Arc::clone(control))?;
    let output = process.output.take().ok_or("媒体探测输出不可用")?;
    let mut bytes = Vec::new();
    loop {
        control.check()?;
        if Instant::now() >= deadline { return Err("媒体信息读取超时".into()); }
        match output.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(part)) => { if bytes.len() + part.len() > policy().max_probe_bytes { return Err("媒体信息超过限制".into()); } bytes.extend(part); }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {},
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    process.finish(deadline)?; Ok(bytes)
}
