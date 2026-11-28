//! trylo-pty — a native pseudo-terminal sidecar for the Trylo CLI.
//!
//! # Why this exists
//!
//! The CLI is TypeScript on Node. Node has no pseudo-terminal: `spawn` gives
//! three pipes, and nothing tells the program on the other end that a person is
//! watching. A program that changes behaviour when it believes it has a
//! terminal — line editing, progress redraw, colour, `isatty` gating — runs
//! differently under pipes than it would for a human at a keyboard. That is not
//! cosmetic. `portable-pty` gives the CLI ConPTY on Windows and a POSIX PTY
//! on macOS.
//!
//! # Why a sidecar rather than a native addon
//!
//! `portable-pty` is Rust. The alternative to a helper process is a compiled
//! addon, which puts a C++ toolchain between a user and `npm install`. A helper
//! keeps the shipped artifact a single executable that staging
//! hash-verifies like every other vendored helper here.
//!
//! # Protocol
//!
//! Length-prefixed frames. Never line-delimited text.
//!
//! ```text
//! +--------+------------------+-------------------+
//! | 1 byte | 4 bytes LE u32   | N bytes           |
//! | type   | payload length   | payload           |
//! +--------+------------------+-------------------+
//! ```
//!
//! Control frames (`spawn`, `resize`) carry JSON. Data frames carry **raw
//! bytes**: terminal output is ANSI escapes, partial UTF-8 sequences at a read
//! boundary, and NUL bytes, and any scheme that routes those through a string
//! corrupts at least one of them. So `write` is `[u32 id_len][id][raw input]`
//! and `data` is raw output — the framing exists precisely so no escaping is
//! needed anywhere on the hot path.
//!
//! # Handshake
//!
//! The first frame must be `hello` carrying the protocol version the caller
//! speaks. The sidecar answers with its own before checking the match, so the
//! parent learns what this build actually is; on mismatch both sides fail
//! explicitly. A sidecar that silently accepted a neighbouring protocol would
//! emit output shaped like a terminal but missing whatever the other version
//! added — the hardest kind of wrong to notice.

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;

/// Bumped whenever the frame layout or any payload meaning changes.
const PROTOCOL_VERSION: u32 = 2;
const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

// Node -> sidecar
//
// `write`/`eof` carry `[u32 idLen][id][raw bytes]`, so an id can never collide
// with the payload's own bytes. The same shape is reused for `data` on the way
// back, because the alternative — a bare data frame with no id — means the
// parent cannot tell which of several live terminals produced a byte, and one
// terminal's output lands in another's buffer with nothing to detect it.
const OP_HELLO: u8 = 1;
const OP_SPAWN: u8 = 2;
const OP_WRITE: u8 = 3;
const OP_EOF: u8 = 4;
const OP_RESIZE: u8 = 5;
const OP_KILL: u8 = 6;

// sidecar -> Node
const EV_HELLO: u8 = 1;
const EV_READY: u8 = 2;
const EV_DATA: u8 = 3;
const EV_EXIT: u8 = 4;
const EV_ERROR: u8 = 5;

/// A frame claiming more than this is a protocol error, not a large frame.
/// Refusing beats allocating whatever the sender asked for.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// The minimum a Windows loader needs to start anything at all. Not a
/// convenience list: without these, `CreateProcessW` rejects the environment
/// block outright.
#[cfg(windows)]
const TERMINAL_ENVIRONMENT: &[&str] = &["SystemRoot", "COMSPEC", "PATH", "TEMP"];

#[cfg(unix)]
const TERMINAL_ENVIRONMENT: &[&str] = &["TERM", "HOME", "TMPDIR", "LANG", "LC_ALL", "PATH"];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct HelloPayload {
    protocol: u32,
}

#[derive(Deserialize)]
struct SpawnPayload {
    id: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: Vec<(String, String)>,
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
struct ResizePayload {
    id: String,
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
struct IdPayload {
    id: String,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

struct Session {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Retained so a resize can reach the kernel. `MasterPty::resize` takes
    /// `&self`, so this needs no interior mutability of its own — but the
    /// registry has to hand it out, hence the outer `Mutex`.
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Session>,
}

fn emit(out: &Arc<Mutex<io::Stdout>>, kind: u8, payload: &[u8]) {
    let mut stream = match out.lock() {
        Ok(guard) => guard,
        // A poisoned lock means a writer thread panicked. Every other session
        // still has output to deliver, so recover the guard rather than
        // deadlocking them all behind one dead writer.
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    if stream.write_all(&header).is_err() || stream.write_all(payload).is_err() {
        return;
    }
    let _ = stream.flush();
}

fn emit_error(out: &Arc<Mutex<io::Stdout>>, id: Option<&str>, code: &str, message: &str) {
    let id_part = match id {
        Some(id) => format!("\"id\":{},", json_string(id)),
        None => String::new(),
    };
    emit(
        out,
        EV_ERROR,
        format!(
            "{{{}{}\"code\":{},\"message\":{}}}",
            id_part,
            if id_part.is_empty() { "" } else { "" },
            json_string(code),
            json_string(message)
        )
        .as_bytes(),
    );
}

/// JSON string escaping. The sidecar emits JSON and a Windows path may contain
/// a quote or a backslash, so an unescaped value would produce a document the
/// parent cannot parse — at exactly the moment something has already gone
/// wrong.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Pull one frame. `Ok(None)` means stdin closed, which is the signal to tear
/// every session down rather than leave orphans holding a console.
fn read_frame(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut kind = [0u8; 1];
    match input.read_exact(&mut kind) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut len_bytes = [0u8; 4];
    input.read_exact(&mut len_bytes)?;
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame payload of {len} bytes exceeds the {MAX_FRAME_BYTES} byte ceiling"),
        ));
    }
    let mut payload = vec![0u8; len];
    input.read_exact(&mut payload)?;
    Ok(Some((kind[0], payload)))
}

/// Prefix a payload with its session id. The id is length-prefixed rather than
/// NUL-separated so that no id byte can be confused with a separator, and so
/// the raw bytes after it need no escaping at all.
fn with_id(id: &str, body: &[u8]) -> Vec<u8> {
    let id_bytes = id.as_bytes();
    let mut out = Vec::with_capacity(4 + id_bytes.len() + body.len());
    out.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(id_bytes);
    out.extend_from_slice(body);
    out
}

/// Split an id-prefixed payload back into its id and the bytes after it.
fn split_write_payload(payload: &[u8]) -> Result<(String, &[u8]), String> {
    if payload.len() < 4 {
        return Err("write payload is shorter than its id length prefix".to_string());
    }
    let id_len = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let start = 4 + id_len;
    if payload.len() < start {
        return Err("write payload id runs past the frame".to_string());
    }
    let id = std::str::from_utf8(&payload[4..start])
        .map_err(|e| format!("write payload id is not utf-8: {e}"))?
        .to_string();
    Ok((id, &payload[start..]))
}

fn parse_json<T: for<'de> Deserialize<'de>>(payload: &[u8]) -> Result<T, String> {
    serde_json::from_slice(payload).map_err(|e| e.to_string())
}

fn spawn_session(
    payload: &[u8],
    out: &Arc<Mutex<io::Stdout>>,
    registry: &Arc<Mutex<Registry>>,
) {
    let request: SpawnPayload = match parse_json(payload) {
        Ok(request) => request,
        Err(message) => {
            emit_error(out, None, "pty_spawn_refused", &message);
            return;
        }
    };
    // The caller is required to send an absolute path, and this is where that is
    // enforced rather than assumed. `portable-pty` would otherwise search using
    // the environment it was handed — and this sidecar clears that environment
    // on purpose, so a bare name either fails with a message about *its* env or,
    // worse, is resolved by a rule set the sandbox never approved. Refusing here
    // means the answer to "what runs" comes from exactly one place.
    if !Path::new(&request.program).is_absolute() {
        emit_error(
            out,
            Some(&request.id),
            "pty_program_not_absolute",
            &format!(
                "program must be an absolute path; the caller resolves names, the sidecar does not. got {:?}",
                request.program
            ),
        );
        return;
    }

    let native = portable_pty::native_pty_system();
    let size = PtySize {
        rows: request.rows,
        cols: request.cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match native.openpty(size) {
        Ok(pair) => pair,
        Err(e) => {
            emit_error(out, Some(&request.id), "pty_open_failed", &e.to_string());
            return;
        }
    };

    let mut command = CommandBuilder::new(&request.program);
    for arg in &request.args {
        command.arg(arg);
    }
    command.cwd(&request.cwd);
    // `env_clear` then re-add. Without the clear, every program launched in a
    // terminal inherits the CLI's whole environment — including any credential
    // in it — which is the same leak `childEnvironment()` exists to prevent on
    // the pipes path. Both paths must have the same guarantee.
    command.env_clear();
    for (key, value) in &request.env {
        command.env(key, value);
    }
    // `portable-pty` builds the `CreateProcessW` environment block from exactly
    // what was set here. An empty block is not an empty environment — it is an
    // invalid one, and `CreateProcessW` answers `ERROR_INVALID_PARAMETER` (87).
    // Measured on this machine: env_clear() with nothing added fails to start
    // `cmd.exe`, while the same call with these four succeeds.
    //
    // The caller is expected to send its own whitelist, but it may not know
    // what a *Windows* loader needs. Supplying the loader's own floor here
    // keeps that knowledge on the platform side of the bridge, where the same
    // four are also what `cmd.exe` uses to find `PATH`, `%TEMP%` and the
    // profile directory. They carry no credential: each names a directory, not
    // a secret, and any variable that could hold one was dropped by the clear
    // above and is not re-added.
    for &key in TERMINAL_ENVIRONMENT {
        if command.get_env(key).is_none() {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    #[cfg(unix)]
    if command.get_env("TERM").is_none() {
        command.env("TERM", "xterm-256color");
    }

    let mut child: Box<dyn Child + Send + Sync> = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(e) => {
            emit_error(out, Some(&request.id), "pty_spawn_failed", &e.to_string());
            return;
        }
    };
    let pid = child.process_id();
    let killer = child.clone_killer();

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            emit_error(out, Some(&request.id), "pty_io_failed", &e.to_string());
            return;
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            emit_error(out, Some(&request.id), "pty_io_failed", &e.to_string());
            return;
        }
    };

    registry.lock().unwrap().sessions.insert(
        request.id.clone(),
        Session {
            writer,
            killer,
            master: pair.master,
        },
    );

    emit(
        out,
        EV_READY,
        format!(
            "{{\"id\":{},\"pid\":{}}}",
            json_string(&request.id),
            pid.unwrap_or(0)
        )
        .as_bytes(),
    );

    // One thread moves bytes out; another waits for exit. They are separate
    // because a terminal's reader can stay blocked on a pipe a surviving
    // grandchild still holds — and that must not delay the exit report, or a
    // finished session looks like a hung one.
    let out_for_reader = Arc::clone(out);
    // Two threads need the id and only one of them outlives the other, so each
    // gets its own copy rather than sharing a moved value.
    let id_for_reader = request.id.clone();
    let id_for_waiter = request.id.clone();
    let reader_thread = thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // The id rides with the bytes. Without it a parent running two
                // terminals at once has no way to attribute output, and the
                // bytes of one end up in the other's buffer — indistinguishable
                // from a program that printed the wrong thing.
                Ok(n) => emit(
                    &out_for_reader,
                    EV_DATA,
                    &with_id(&id_for_reader, &buf[..n]),
                ),
            }
        }
    });

    let out_for_waiter = Arc::clone(out);
    let registry_for_waiter = Arc::clone(registry);
    thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        // Drop the session before reporting, so a `kill` arriving after exit
        // finds nothing and says so instead of signalling a dead pid.
        registry_for_waiter
            .lock()
            .unwrap()
            .sessions
            .remove(&id_for_waiter);
        reader_thread.join().ok();
        emit(
            &out_for_waiter,
            EV_EXIT,
            format!(
                "{{\"id\":{},\"code\":{}}}",
                json_string(&id_for_waiter),
                code
            )
            .as_bytes(),
        );
    });
}

fn handle_write(
    kind: u8,
    payload: &[u8],
    out: &Arc<Mutex<io::Stdout>>,
    registry: &Arc<Mutex<Registry>>,
) {
    let (id, body) = match split_write_payload(payload) {
        Ok(parts) => parts,
        Err(message) => {
            emit_error(out, None, "pty_write_refused", &message);
            return;
        }
    };
    let mut guard = registry.lock().unwrap();
    let session = match guard.sessions.get_mut(&id) {
        Some(session) => session,
        None => {
            drop(guard);
            emit_error(out, Some(&id), "pty_session_not_found", "no such pty session");
            return;
        }
    };
    let outcome = if kind == OP_EOF {
        session.writer.flush()
    } else {
        session.writer.write_all(body).and_then(|()| session.writer.flush())
    };
    if let Err(e) = outcome {
        drop(guard);
        emit_error(out, Some(&id), "pty_write_failed", &e.to_string());
    }
}

fn handle_resize(payload: &[u8], out: &Arc<Mutex<io::Stdout>>, registry: &Arc<Mutex<Registry>>) {
    let request: ResizePayload = match parse_json(payload) {
        Ok(request) => request,
        Err(message) => {
            emit_error(out, None, "pty_resize_refused", &message);
            return;
        }
    };
    let guard = registry.lock().unwrap();
    let session = match guard.sessions.get(&request.id) {
        Some(session) => session,
        None => {
            drop(guard);
            emit_error(out, Some(&request.id), "pty_session_not_found", "no such pty session");
            return;
        }
    };
    let outcome = session.master.resize(PtySize {
        rows: request.rows,
        cols: request.cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    if let Err(e) = outcome {
        drop(guard);
        emit_error(out, Some(&request.id), "pty_resize_failed", &e.to_string());
    }
}

fn handle_kill(payload: &[u8], out: &Arc<Mutex<io::Stdout>>, registry: &Arc<Mutex<Registry>>) {
    let request: IdPayload = match parse_json(payload) {
        Ok(request) => request,
        Err(message) => {
            emit_error(out, None, "pty_kill_refused", &message);
            return;
        }
    };
    let session = registry.lock().unwrap().sessions.remove(&request.id);
    match session {
        Some(mut session) => {
            // A failed kill is not reported as a failure, because on Windows it
            // usually is not one. `ChildKiller::kill` closes the pseudoconsole
            // before terminating the child, and the close leaves the handle the
            // termination was about to use invalid — so it reports
            // ERROR_INVALID_HANDLE (6) *and* the process does die, which was
            // measured on this machine: the `pty_kill_failed` frame arrived and
            // the `exit` frame followed a moment later with the real code.
            //
            // Reporting the error would therefore tell the parent that the stop
            // failed while it was succeeding. The exit frame is the authority;
            // if the process really is still running, the parent sees no exit
            // and reaches its own "killed but unobserved" conclusion, which is
            // the honest place for that judgement to be made.
            let _ = session.killer.kill();
        }
        None => emit_error(
            out,
            Some(&request.id),
            "pty_session_not_found",
            "no such pty session",
        ),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let out = Arc::new(Mutex::new(stdout));
    let registry: Arc<Mutex<Registry>> = Arc::new(Mutex::new(Registry::default()));

    // The handshake comes first and nothing may precede it.
    let asked_for = match read_frame(&mut input) {
        Ok(Some((OP_HELLO, payload))) => match parse_json::<HelloPayload>(&payload) {
            Ok(hello) => hello.protocol,
            Err(message) => {
                emit_error(&out, None, "pty_handshake_refused", &message);
                return;
            }
        },
        Ok(_) => {
            emit_error(
                &out,
                None,
                "pty_handshake_missing",
                "the first frame must be hello",
            );
            return;
        }
        Err(e) => {
            emit_error(&out, None, "pty_handshake_failed", &e.to_string());
            return;
        }
    };

    // Answered before the check, so a mismatched caller learns what this build
    // actually speaks instead of only that the guess failed.
    emit(
        &out,
        EV_HELLO,
        format!(
            "{{\"protocol\":{PROTOCOL_VERSION},\"version\":{}}}",
            json_string(HELPER_VERSION)
        )
        .as_bytes(),
    );
    if asked_for != PROTOCOL_VERSION {
        emit_error(
            &out,
            None,
            "pty_protocol_mismatch",
            &format!(
                "sidecar speaks protocol {PROTOCOL_VERSION}, caller asked for {asked_for}"
            ),
        );
        return;
    }

    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            // stdin closed: the parent is gone, so every session goes with it.
            Ok(None) | Err(_) => break,
        };
        let (kind, payload) = frame;
        match kind {
            OP_SPAWN => spawn_session(&payload, &out, &registry),
            OP_WRITE | OP_EOF => handle_write(kind, &payload, &out, &registry),
            OP_RESIZE => handle_resize(&payload, &out, &registry),
            OP_KILL => handle_kill(&payload, &out, &registry),
            other => emit_error(
                &out,
                None,
                "pty_unknown_op",
                &format!("unknown frame type {other}"),
            ),
        }
    }

    // The CLI exited without stopping anything. Kill what is left rather than
    // leaving processes attached to a console nobody is reading.
    let mut guard = registry.lock().unwrap();
    for (_, mut session) in guard.sessions.drain() {
        let _ = session.killer.kill();
    }
}
