//! Bounded, shell-owned output retention. Reading never spawns or resends input.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::error::{io_error, CommandError};

const OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_RECORDS: usize = 8192;
const COMPLETED_BYTES: usize = 64 * 1024 * 1024;
const COMPLETED_COUNT: usize = 32;
const READ_RECORDS: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryIdentity {
    pub team_run_id: String,
    pub turn_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryProcess {
    pub id: String,
    pub pid: u32,
    pub project_key: String,
    pub conversation_id: String,
    pub identity: RecoveryIdentity,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRecord {
    sequence: u64,
    stream: String,
    line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
// These wire flags describe independent pagination, retention and exit facts.
#[allow(clippy::struct_excessive_bools)]
pub struct RecoveryOutput {
    version: u8,
    process: RecoveryProcess,
    records: Vec<OutputRecord>,
    next_sequence: u64,
    has_more: bool,
    gap: bool,
    finished: bool,
    capture_complete: bool,
    exit: Option<serde_json::Value>,
    answered_requests: Vec<String>,
}

pub struct OutputJournal {
    process: RecoveryProcess,
    records: VecDeque<OutputRecord>,
    bytes: usize,
    sequence: u64,
    finished: bool,
    capture_complete: bool,
    exit: Option<serde_json::Value>,
    answered_requests: Vec<String>,
}

impl OutputJournal {
    fn new(process: RecoveryProcess) -> Self {
        Self {
            process,
            records: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            finished: false,
            capture_complete: true,
            exit: None,
            answered_requests: Vec::new(),
        }
    }

    pub fn record(&mut self, stream: &str, line: &str) {
        // An inherited pipe can outlive the root. The bounded exit receipt seals
        // the transcript; late lines cannot reopen it or overtake its terminal.
        if self.finished {
            return;
        }
        self.sequence += 1;
        if line.len() > OUTPUT_BYTES {
            self.capture_complete = false;
            return;
        }
        self.records.push_back(OutputRecord {
            sequence: self.sequence,
            stream: stream.into(),
            line: line.into(),
        });
        self.bytes += line.len();
        while self.bytes > OUTPUT_BYTES || self.records.len() > OUTPUT_RECORDS {
            if let Some(record) = self.records.pop_front() {
                self.bytes -= record.line.len();
            }
        }
    }

    pub fn finish(&mut self, exit: serde_json::Value, capture_complete: bool) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.capture_complete &= capture_complete;
        self.exit = Some(exit);
    }

    fn read(&self, after: u64) -> RecoveryOutput {
        let records: Vec<_> = self
            .records
            .iter()
            .filter(|record| record.sequence > after)
            .take(READ_RECORDS)
            .cloned()
            .collect();
        let next = records.last().map_or(after, |record| record.sequence);
        let first = self
            .records
            .front()
            .map_or(self.sequence + 1, |record| record.sequence);
        RecoveryOutput {
            version: 1,
            process: self.process.clone(),
            records,
            next_sequence: next,
            has_more: self
                .records
                .back()
                .is_some_and(|record| record.sequence > next),
            gap: after > self.sequence || after.saturating_add(1) < first,
            finished: self.finished,
            capture_complete: self.capture_complete,
            exit: self.exit.clone(),
            answered_requests: self.answered_requests.clone(),
        }
    }
}

type Journal = Arc<Mutex<OutputJournal>>;
#[derive(Default)]
pub struct RecoveryStore {
    journals: HashMap<String, Journal>,
    completed: VecDeque<String>,
}
pub fn register(store: &Mutex<RecoveryStore>, process: RecoveryProcess) -> Journal {
    let id = process.id.clone();
    let journal = Arc::new(Mutex::new(OutputJournal::new(process)));
    if let Ok(mut state) = store.lock() {
        state.journals.insert(id, Arc::clone(&journal));
    }
    journal
}

pub fn mark_completed(store: &Mutex<RecoveryStore>, id: &str) {
    if let Ok(mut state) = store.lock() {
        state.completed.push_back(id.into());
        let mut bytes: usize = state
            .completed
            .iter()
            .filter_map(|id| state.journals.get(id))
            .filter_map(|journal| journal.lock().ok().map(|journal| journal.bytes))
            .sum();
        while state.completed.len() > COMPLETED_COUNT || bytes > COMPLETED_BYTES {
            let Some(oldest) = state.completed.pop_front() else {
                break;
            };
            if let Some(journal) = state.journals.remove(&oldest) {
                if let Ok(journal) = journal.lock() {
                    bytes = bytes.saturating_sub(journal.bytes);
                }
            }
        }
    }
}

/// Record only the correlation id of a successfully written response, never
/// prompt contents or credentials. A reader uses this to avoid reviving old cards.
pub fn answer_id(message: &str) -> Option<String> {
    let frame = serde_json::from_str::<serde_json::Value>(message.trim()).ok()?;
    if frame.get("type").and_then(serde_json::Value::as_str) != Some("control_response") {
        return None;
    }
    frame
        .pointer("/response/request_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

pub fn record_answer(store: &Mutex<RecoveryStore>, id: &str, request_id: &str) {
    let journal = store
        .lock()
        .ok()
        .and_then(|state| state.journals.get(id).cloned());
    if let Some(journal) = journal {
        if let Ok(mut journal) = journal.lock() {
            if journal.answered_requests.len() >= OUTPUT_RECORDS {
                journal.capture_complete = false;
                return;
            }
            if !journal.answered_requests.iter().any(|id| id == request_id) {
                journal.answered_requests.push(request_id.into());
            }
        }
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts its managed State by value.
pub fn process_recovery_list(
    state: tauri::State<'_, super::process_state::ProcessState>,
) -> Result<Vec<RecoveryProcess>, CommandError> {
    let state = state
        .recovery
        .lock()
        .map_err(|_| recovery_error("recovery store poisoned"))?;
    state
        .journals
        .values()
        .map(|journal| {
            journal
                .lock()
                .map(|journal| journal.process.clone())
                .map_err(|_| recovery_error("output journal poisoned"))
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts its managed State by value.
pub fn process_read_output(
    id: &str,
    after_sequence: u64,
    state: tauri::State<'_, super::process_state::ProcessState>,
) -> Result<RecoveryOutput, CommandError> {
    let journal = state
        .recovery
        .lock()
        .map_err(|_| recovery_error("recovery store poisoned"))?
        .journals
        .get(id)
        .cloned()
        .ok_or_else(|| recovery_error("retained output unavailable"))?;
    let result = journal
        .lock()
        .map_err(|_| recovery_error("output journal poisoned"))?
        .read(after_sequence);
    Ok(result)
}

fn recovery_error(message: &str) -> CommandError {
    io_error("(process recovery)", std::io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn journal() -> OutputJournal {
        OutputJournal::new(RecoveryProcess {
            id: "p".into(),
            pid: 1,
            project_key: "w".into(),
            conversation_id: "c".into(),
            identity: RecoveryIdentity {
                team_run_id: "team".into(),
                turn_id: "turn".into(),
            },
        })
    }
    #[test]
    fn retention_is_sequenced_separate_and_survives_exit() {
        let mut journal = journal();
        journal.record("stdout", "result");
        journal.record("stderr", "diagnostic");
        journal.finish(serde_json::json!({"code": 0}), true);
        journal.record("stdout", "late");
        let first = journal.read(0);
        assert_eq!(first.records.len(), 2);
        assert!(first.finished && first.capture_complete && !first.gap);
        assert_eq!(first.records[1].stream, "stderr");
        assert_eq!(first.next_sequence, 2);
        assert!(journal.read(2).records.is_empty());
    }
    #[test]
    fn bounded_retention_reports_eviction_and_oversized_record() {
        let mut journal = journal();
        for _ in 0..=OUTPUT_RECORDS {
            journal.record("stdout", "x");
        }
        assert!(journal.read(0).gap);
        assert!(!journal.read(1).gap);
        journal.record("stdout", &"x".repeat(OUTPUT_BYTES + 1));
        assert!(!journal.read(0).capture_complete);
    }
    #[test]
    fn pagination_does_not_skip_unread_tail() {
        let mut journal = journal();
        for _ in 0..READ_RECORDS + 3 {
            journal.record("stdout", "line");
        }
        let page = journal.read(0);
        assert!(page.has_more);
        let tail = journal.read(page.next_sequence);
        assert_eq!(tail.records.len(), 3);
        assert!(!tail.has_more);
    }
}
