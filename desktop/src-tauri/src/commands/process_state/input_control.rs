use std::io::{self, Write};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, TryLockError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum InputState {
    Open = 0,
    Closing = 1,
    Closed = 2,
    Exited = 3,
}

/// Serializes whole input frames without holding the process registry.
pub struct ProcessInputControl {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    state: AtomicU8,
}

impl ProcessInputControl {
    pub fn new(writer: Option<Box<dyn Write + Send>>) -> Arc<Self> {
        let state = if writer.is_some() {
            InputState::Open
        } else {
            InputState::Closed
        };
        Arc::new(Self {
            writer: Mutex::new(writer),
            state: AtomicU8::new(state as u8),
        })
    }

    fn state(&self) -> InputState {
        match self.state.load(Ordering::Acquire) {
            0 => InputState::Open,
            1 => InputState::Closing,
            2 => InputState::Closed,
            3 => InputState::Exited,
            _ => unreachable!("input state is only written with InputState values"),
        }
    }

    pub fn accepts_input(&self) -> bool {
        self.state() == InputState::Open
    }

    pub fn send_line(&self, message: String) -> io::Result<()> {
        if !self.accepts_input() {
            return Err(closed_input());
        }
        let mut slot = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("process input lock poisoned"))?;
        // A close or real exit may have happened while this sender queued.
        if !self.accepts_input() {
            return Err(closed_input());
        }
        let writer = slot.as_mut().ok_or_else(closed_input)?;
        let mut bytes = message.into_bytes();
        if bytes.last() != Some(&b'\n') {
            bytes.push(b'\n');
        }
        let result = writer.write_all(&bytes).and_then(|()| writer.flush());
        if self.state() == InputState::Exited {
            slot.take();
        }
        result
    }

    /// A close request rejects new writes immediately. Its receipt waits for
    /// the in-flight frame and actual EOF, but only on this input's mutex.
    pub fn close(&self) -> io::Result<()> {
        if matches!(self.state(), InputState::Closed | InputState::Exited) {
            return Ok(());
        }
        let _ = self.state.compare_exchange(
            InputState::Open as u8,
            InputState::Closing as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        let mut slot = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("process input lock poisoned"))?;
        if let Some(mut writer) = slot.take() {
            // Preserve the existing EOF contract: even a failed final flush
            // must drop stdin. It is not evidence of process exit or Stop.
            let _ = writer.flush();
            drop(writer);
        }
        // A concurrent real exit must never be overwritten by close completion.
        let _ = self.state.compare_exchange(
            InputState::Closing as u8,
            InputState::Closed as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        Ok(())
    }

    /// Reaping may never wait for stdin IO. A sender already holding the
    /// writer releases it after the OS unblocks that write; queued sends fail.
    pub fn mark_exited(&self) {
        self.state
            .store(InputState::Exited as u8, Ordering::Release);
        match self.writer.try_lock() {
            Ok(mut slot) => {
                slot.take();
            }
            Err(TryLockError::Poisoned(error)) => {
                error.into_inner().take();
            }
            Err(TryLockError::WouldBlock) => {}
        }
    }
}

fn closed_input() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "process stdin is closed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::process_state::test_input::{blocked_input, HoldAt};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    struct ShortWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for ShortWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().push(bytes[0]);
            std::thread::yield_now();
            Ok(1)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn concurrent_senders_keep_whole_lines_and_preserve_an_existing_line_ending() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let input = ProcessInputControl::new(Some(Box::new(ShortWriter(Arc::clone(&bytes)))));
        let workers: Vec<_> = (0..16)
            .map(|index| {
                let input = Arc::clone(&input);
                std::thread::spawn(move || {
                    input
                        .send_line(format!("message-{index}:中文🚀\n"))
                        .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        input.send_line("tail\r\n".into()).unwrap();
        input.close().unwrap();
        let text = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        let mut actual: Vec<_> = text.lines().take(16).collect();
        actual.sort_unstable();
        let mut expected: Vec<_> = (0..16)
            .map(|index| format!("message-{index}:中文🚀"))
            .collect();
        expected.sort_unstable();
        assert_eq!(actual, expected);
        assert!(text.ends_with("tail\r\n"));
        assert_eq!(
            input.send_line("after EOF".into()).unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn a_close_request_rejects_queued_input_but_waits_for_the_existing_frame_to_finish() {
        let fixture = blocked_input(HoldAt::Write);
        let input = ProcessInputControl::new(Some(fixture.writer));
        let sending = Arc::clone(&input);
        let worker = std::thread::spawn(move || sending.send_line("in flight".into()));
        let entered = fixture.entered.recv_timeout(Duration::from_secs(2));
        let closing = Arc::clone(&input);
        let (receipt, observed_close) = mpsc::channel();
        let closer = std::thread::spawn(move || {
            let result = closing.close();
            receipt.send(()).unwrap();
            result
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while input.accepts_input() && Instant::now() < deadline {
            std::thread::yield_now();
        }
        let requested = !input.accepts_input();
        let close_still_waits = matches!(observed_close.try_recv(), Err(mpsc::TryRecvError::Empty));
        let late = if requested {
            input
                .send_line("must not be written".into())
                .err()
                .map(|error| error.kind())
        } else {
            None
        };
        let _ = fixture.release.send(());
        worker.join().unwrap().unwrap();
        closer.join().unwrap().unwrap();
        assert!(entered.is_ok());
        assert!(requested);
        assert!(close_still_waits);
        assert_eq!(late, Some(io::ErrorKind::BrokenPipe));
        assert_eq!(input.state(), InputState::Closed);
    }

    #[test]
    fn actual_exit_does_not_wait_for_a_blocked_writer_and_cannot_be_revived_by_its_late_success() {
        let fixture = blocked_input(HoldAt::Write);
        let input = ProcessInputControl::new(Some(fixture.writer));
        let sending = Arc::clone(&input);
        let worker = std::thread::spawn(move || sending.send_line("in flight".into()));
        let entered = fixture.entered.recv_timeout(Duration::from_secs(2));
        let exiting = Arc::clone(&input);
        let (done, observed_exit) = mpsc::channel();
        let reaper = std::thread::spawn(move || {
            exiting.mark_exited();
            done.send(()).unwrap();
        });
        let exited_without_waiting = observed_exit.recv_timeout(Duration::from_secs(2)).is_ok();
        let _ = fixture.release.send(());
        worker.join().unwrap().unwrap();
        reaper.join().unwrap();
        assert!(entered.is_ok());
        assert!(exited_without_waiting);
        assert_eq!(input.state(), InputState::Exited);
        assert!(!input.accepts_input());
        assert_eq!(
            input.send_line("late".into()).unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        input.close().unwrap();
        assert_eq!(input.state(), InputState::Exited);
    }

    #[cfg(windows)]
    #[test]
    fn a_real_child_with_stdin_backpressure_remains_stoppable_and_reaps_its_blocked_sender() {
        use crate::commands::process_state::{
            ProcessEntry, ProcessMetadata, ProcessState, ProcessStopControl,
        };
        use crate::commands::process_termination::OwnedTreeTerminator;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime/node/win-x64/node.exe");
        let mut child = Command::new(node)
            .args([
                "-e",
                "/* trylo-native-input-backpressure-20261026 */ setInterval(()=>{},1000);",
            ])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let terminator = OwnedTreeTerminator::capture(&child).unwrap();
        let input = ProcessInputControl::new(Some(Box::new(child.stdin.take().unwrap())));
        let stop = ProcessStopControl::new(move || terminator.terminate());
        let state = ProcessState::default();
        state.processes.lock().unwrap().insert(
            "owned-input-probe".into(),
            ProcessEntry {
                input: Arc::clone(&input),
                stop: Arc::clone(&stop),
                label: "input-probe".into(),
                pid: child.id(),
                metadata: ProcessMetadata::default(),
            },
        );
        let sending = Arc::clone(&input);
        let sender = std::thread::spawn(move || sending.send_line("x".repeat(4 * 1024 * 1024)));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut writing = false;
        while Instant::now() < deadline {
            if matches!(input.writer.try_lock(), Err(TryLockError::WouldBlock)) {
                writing = true;
                break;
            }
            std::thread::yield_now();
        }
        let readable = state.processes.try_lock().is_ok();
        let stopped = stop.request_stop();
        if stopped.is_err() {
            let _ = child.kill();
        }
        let status = child.wait();
        input.mark_exited();
        stop.mark_exited();
        state.processes.lock().unwrap().remove("owned-input-probe");
        let send_result = sender.join().unwrap();
        assert!(writing, "actual stdin write never acquired the input owner");
        assert!(readable);
        stopped.unwrap();
        status.unwrap();
        assert!(send_result.is_err());
        assert_eq!(input.state(), InputState::Exited);
        assert!(state.processes.lock().unwrap().is_empty());
    }
}
