// Trylo Desktop — shared Tauri command error. See the architecture doc §10.2.
//
// "Errors carry context. `anyhow::Result` is fine; `eyre` is fine; bare
//  `String` is not." We use thisenum + thiserror for typed errors that
//  also serialize cleanly to the JS side (Tauri 2 needs E: Serialize for
//  command Result<T, E>).

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("io error on {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("not a file: {path}")]
    NotAFile { path: PathBuf },

    #[error("not a directory: {path}")]
    NotADirectory { path: PathBuf },

    // P2-1 Work Package B: attachment staging rejects that are NOT
    // plain IO failures (symlink, directory, oversized, bad id,
    // containment escape). Carries a one-line human reason the
    // renderer surfaces as a failed-attachment chip.
    #[error("attachment rejected: {reason}")]
    Validation { reason: String },
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

/// Helper: build a `CommandError::Io` without repeating the
/// `path: ..., source: ...` field-name ceremony at every call
/// site. Used by all the Tauri commands so error returns stay
/// one-liner-shaped.
pub fn io_error(path: &str, source: std::io::Error) -> CommandError {
    CommandError::Io {
        path: PathBuf::from(path),
        source,
    }
}
