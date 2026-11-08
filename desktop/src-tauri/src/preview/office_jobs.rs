//! Cancellation belongs to a preview request, never to a filename or PID.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use crate::commands::process_termination::OwnedTreeTerminator;

pub const CANCELLED: &str = "页面预览已取消";
#[derive(Default)]
struct Jobs {
    stopping: bool,
    tokens: HashMap<String, watch::Sender<bool>>,
    early_cancels: VecDeque<String>,
    active: Option<(String, OwnedTreeTerminator)>,
}
#[derive(Default)]
pub struct OfficeJobs(Mutex<Jobs>);
pub struct OfficeJob { owner: Arc<OfficeJobs>, id: String, cancel: watch::Receiver<bool> }
fn valid_id(id: &str) -> bool { (32..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') }
impl OfficeJobs {
    #[cfg(test)]
    pub fn is_active(&self, id: &str) -> bool {
        self.0.lock().unwrap().active.as_ref().is_some_and(|(active, _)| active == id)
    }
    pub fn begin(self: &Arc<Self>, id: String) -> Result<OfficeJob, String> {
        if !valid_id(&id) { return Err("页面预览请求标识无效".into()); }
        let mut jobs = self.0.lock().map_err(|_| "预览作业状态不可用")?;
        if jobs.stopping { return Err("应用正在关闭，无法启动页面预览".into()); }
        if jobs.tokens.contains_key(&id) { return Err("页面预览请求标识已在使用".into()); }
        if jobs.tokens.len() >= 8 { return Err("待预览文档较多，请稍后重试".into()); }
        let cancelled = jobs.early_cancels.iter().any(|item| item == &id);
        jobs.early_cancels.retain(|item| item != &id);
        let (sender, cancel) = watch::channel(cancelled);
        jobs.tokens.insert(id.clone(), sender);
        Ok(OfficeJob { owner: Arc::clone(self), id, cancel })
    }
    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        if !valid_id(id) { return Err("页面预览请求标识无效".into()); }
        let mut jobs = self.0.lock().map_err(|_| "预览作业状态不可用")?;
        if let Some(token) = jobs.tokens.get(id) { token.send_replace(true); return Ok(true); }
        // IPC delivery can race the start of the async conversion command.
        if !jobs.early_cancels.iter().any(|item| item == id) {
            if jobs.early_cancels.len() == 128 { jobs.early_cancels.pop_front(); }
            jobs.early_cancels.push_back(id.to_string());
        }
        Ok(false)
    }
    pub fn shutdown(&self) -> usize {
        let active = {
            let Ok(mut jobs) = self.0.lock() else { return 0; };
            jobs.stopping = true;
            for token in jobs.tokens.values() { token.send_replace(true); }
            jobs.active.take()
        };
        if let Some((_, tree)) = active {
            match tree.terminate() { Ok(()) => return 1, Err(error) => eprintln!("[preview] conversion shutdown failed: {error}") }
        }
        0
    }
}
impl OfficeJob {
    pub fn check(&self) -> Result<(), String> { if *self.cancel.borrow() { Err(CANCELLED.into()) } else { Ok(()) } }
    pub async fn cancelled(&self) { let mut cancel = self.cancel.clone(); let _ = cancel.wait_for(|value| *value).await; }
    pub fn attach(&self, tree: OwnedTreeTerminator) -> Result<(), String> {
        let mut jobs = self.owner.0.lock().map_err(|_| "预览作业状态不可用")?;
        self.check()?;
        if jobs.stopping { return Err(CANCELLED.into()); }
        if jobs.active.is_some() { return Err("已有页面转换作业".into()); }
        jobs.active = Some((self.id.clone(), tree)); Ok(())
    }
    pub fn detach(&self) {
        if let Ok(mut jobs) = self.owner.0.lock() { if jobs.active.as_ref().is_some_and(|(id, _)| id == &self.id) { jobs.active = None; } }
    }
}
impl Drop for OfficeJob {
    fn drop(&mut self) {
        self.detach();
        if let Ok(mut jobs) = self.owner.0.lock() { jobs.tokens.remove(&self.id); jobs.early_cancels.retain(|id| id != &self.id); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn id(number: u8) -> String { format!("00000000-0000-4000-8000-{number:012}") }
    #[tokio::test]
    async fn cancelling_one_request_never_cancels_another() {
        let jobs = Arc::new(OfficeJobs::default());
        let first = jobs.begin(id(1)).unwrap(); let second = jobs.begin(id(2)).unwrap();
        assert!(jobs.cancel(&id(1)).unwrap());
        first.cancelled().await; assert!(first.check().is_err()); assert!(second.check().is_ok());
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), second.cancelled()).await.is_err());
    }
    #[test]
    fn early_cancel_and_duplicate_ids_have_deterministic_ownership() {
        let jobs = Arc::new(OfficeJobs::default());
        assert!(!jobs.cancel(&id(1)).unwrap());
        let job = jobs.begin(id(1)).unwrap(); assert!(job.check().is_err());
        assert!(jobs.begin(id(1)).is_err()); drop(job);
        assert!(jobs.begin(id(1)).unwrap().check().is_ok());
    }
    #[tokio::test]
    async fn shutdown_cancels_waiting_requests_and_refuses_new_work() {
        let jobs = Arc::new(OfficeJobs::default()); let job = jobs.begin(id(1)).unwrap();
        assert_eq!(jobs.shutdown(), 0); job.cancelled().await; assert!(jobs.begin(id(2)).is_err());
    }
}
