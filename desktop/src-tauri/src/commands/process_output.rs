use std::io::{self, BufRead};
use std::sync::mpsc::Receiver;
#[cfg(test)]
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

/// Signal whether every line reached the display queue, including read failures.
#[cfg(test)]
pub fn drain_with_receipt(
    reader: impl BufRead,
    publish: impl FnMut(String) -> bool,
    completion: &Sender<bool>,
) -> io::Result<u64> {
    let result = drain_output(reader, publish);
    let _ = completion.send(matches!(result, Ok(0)));
    result
}

/// One monotonic budget for all streams; a failed stream does not skip the rest.
pub fn await_output_completion(receipts: Vec<Receiver<bool>>, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    let mut complete = true;
    for receipt in receipts {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !matches!(receipt.recv_timeout(remaining), Ok(true)) {
            complete = false;
        }
    }
    complete
}

/// Returns the number of lines discarded after the display channel disconnected.
///
/// # Errors
/// Returns the underlying pipe read error. Display refusal is counted, not fatal.
#[cfg(test)]
pub fn drain_output(reader: impl BufRead, publish: impl FnMut(String) -> bool) -> io::Result<u64> {
    drain_observed_output(reader, publish, |_| {})
}

pub fn drain_observed_output(
    reader: impl BufRead,
    mut publish: impl FnMut(String) -> bool,
    mut observe: impl FnMut(&str),
) -> io::Result<u64> {
    let mut connected = true;
    let mut discarded = 0;
    for line in reader.lines() {
        let line = line?;
        observe(&line);
        // Closing a display channel must not close the child's pipe. Keep
        // consuming without retrying a channel whose WebView is gone.
        if !connected || !publish(line) {
            connected = false;
            discarded += 1;
        }
    }
    Ok(discarded)
}

#[cfg(test)]
mod tests {
    use super::{await_output_completion, drain_output, drain_with_receipt};
    use std::io::{self, BufRead, Cursor, Read};

    #[test]
    fn capture_keeps_every_line_after_the_old_display_disconnects() {
        let mut captured = Vec::new();
        let mut attempts = 0;
        let discarded = super::drain_observed_output(
            Cursor::new("one\ntwo\nthree\n"),
            |_| {
                attempts += 1;
                false
            },
            |line| captured.push(line.to_owned()),
        )
        .unwrap();
        assert_eq!(captured, ["one", "two", "three"]);
        assert_eq!(attempts, 1);
        assert_eq!(discarded, 3);
    }

    #[test]
    fn drain_receipt_includes_display_refusal_and_read_failure() {
        let (done, received) = std::sync::mpsc::channel();
        drain_with_receipt(Cursor::new("tail\n"), |_| false, &done).unwrap();
        assert!(!received.recv().unwrap());
        let (done, received) = std::sync::mpsc::channel();
        assert!(drain_with_receipt(ReadFailure, |_| true, &done).is_err());
        assert!(!received.recv().unwrap());
    }

    #[test]
    fn missing_or_disconnected_reader_does_not_claim_complete_output() {
        let (_held, pending) = std::sync::mpsc::channel();
        assert!(!await_output_completion(
            vec![pending],
            std::time::Duration::ZERO
        ));
        let (sender, disconnected) = std::sync::mpsc::channel();
        drop(sender);
        assert!(!await_output_completion(
            vec![disconnected],
            std::time::Duration::ZERO
        ));
    }

    #[test]
    fn output_streams_share_one_deadline_instead_of_restarting_the_budget() {
        let (first, stdout) = std::sync::mpsc::channel();
        let (second, stderr) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(75));
            let _ = first.send(true);
            std::thread::sleep(std::time::Duration::from_millis(75));
            // The caller's shared deadline may already have dropped this waiter.
            let _ = second.send(true);
        });
        let complete =
            await_output_completion(vec![stdout, stderr], std::time::Duration::from_millis(100));
        worker.join().unwrap();
        assert!(!complete);
    }

    #[test]
    fn both_ready_streams_confirm_complete_output() {
        let (first, stdout) = std::sync::mpsc::channel();
        let (second, stderr) = std::sync::mpsc::channel();
        first.send(true).unwrap();
        second.send(true).unwrap();
        assert!(await_output_completion(
            vec![stdout, stderr],
            std::time::Duration::ZERO
        ));
    }

    #[test]
    fn disconnected_display_does_not_stop_draining_or_retry_the_old_channel() {
        let mut reads = 0;
        let discarded = drain_output(Cursor::new("one\n二\nthree\n"), |_| {
            reads += 1;
            false
        })
        .unwrap();
        assert_eq!(discarded, 3);
        assert_eq!(reads, 1);
    }

    #[test]
    fn delivery_preserves_stream_lines_without_merging_or_adding_output() {
        let mut delivered = Vec::new();
        let discarded = drain_output(Cursor::new("first\r\n中文 🚀\nlast"), |line| {
            delivered.push(line);
            true
        })
        .unwrap();
        assert_eq!(delivered, ["first", "中文 🚀", "last"]);
        assert_eq!(discarded, 0);
    }

    struct ReadFailure;
    impl Read for ReadFailure {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("actual read failure"))
        }
    }
    impl BufRead for ReadFailure {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            Err(io::Error::other("actual read failure"))
        }
        fn consume(&mut self, _: usize) {}
    }

    #[test]
    fn actual_read_failure_remains_an_error_instead_of_a_successful_drain() {
        assert_eq!(
            drain_output(ReadFailure, |_| true).unwrap_err().to_string(),
            "actual read failure"
        );
    }

    #[cfg(windows)]
    #[test]
    fn real_child_finishes_large_output_after_the_display_channel_disconnects() {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("trylo-output-drain-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let marker = directory.join("pipe-drained.txt");
        let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime/node/win-x64/node.exe");
        let script = r"
process.stdout.on('error', () => process.exit(27));
let writes = 0;
function write() {
  while (writes++ < 512) {
    if (!process.stdout.write('PIPE_RELOAD_PROOF ' + 'x'.repeat(8192) + '\n')) {
      process.stdout.once('drain', write);
      return;
    }
  }
  require('node:fs').writeFileSync(process.argv[1], 'DRAINED_AFTER_CHANNEL_CLOSED');
}
write();
";
        let mut child = Command::new(node)
            .args(["-e", script])
            .arg(&marker)
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = drain_output(
            std::io::BufReader::new(child.stdout.take().unwrap()),
            |_| false,
        );
        let status = child.wait().unwrap();
        let proof = std::fs::read_to_string(&marker);
        match std::fs::remove_file(&marker) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => panic!("marker cleanup failed: {error}"),
        }
        std::fs::remove_dir(directory).unwrap();
        assert!(
            status.success(),
            "child exited after display disconnect: {status}"
        );
        assert_eq!(result.unwrap(), 512);
        assert_eq!(proof.unwrap(), "DRAINED_AFTER_CHANNEL_CLOSED");
    }
}
