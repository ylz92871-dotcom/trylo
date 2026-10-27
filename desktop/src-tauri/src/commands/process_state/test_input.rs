use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

#[derive(Clone, Copy)]
pub enum HoldAt {
    Write,
    Flush,
}

pub struct BlockedInput {
    pub writer: Box<dyn Write + Send>,
    pub entered: Receiver<()>,
    pub release: Sender<()>,
}

struct HeldWriter {
    hold_at: HoldAt,
    entered: Option<Sender<()>>,
    release: Receiver<()>,
}

impl HeldWriter {
    fn hold(&mut self) {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    }
}

impl Write for HeldWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if matches!(self.hold_at, HoldAt::Write) {
            self.hold();
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if matches!(self.hold_at, HoldAt::Flush) {
            self.hold();
        }
        Ok(())
    }
}

pub fn blocked_input(hold_at: HoldAt) -> BlockedInput {
    let (entered, observed) = mpsc::channel();
    let (release, held) = mpsc::channel();
    BlockedInput {
        writer: Box::new(HeldWriter {
            hold_at,
            entered: Some(entered),
            release: held,
        }),
        entered: observed,
        release,
    }
}
