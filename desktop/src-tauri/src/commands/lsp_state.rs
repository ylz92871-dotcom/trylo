// Trylo Desktop — LSP shared state. See the architecture doc §2.7
// (LspManager) + §10.2 (one Tauri command per file).
//
// Holds the live LSP processes. The map is keyed by the
// LspHandle.id (a UUID string returned from lsp_spawn). Each
// entry stores the writer (so lsp_send can push JSON-RPC into
// the server's stdin) and a kill closure (so lsp_stop can
// terminate the child process).
//
// LspProcess is a struct, not a trait object map; the writer and
// the killer are concrete types. The LspState has no native
// resources beyond the child processes themselves (those are
// released when the entries are removed by lsp_stop or by a
// shutdown hook).

use std::collections::HashMap;
use std::io::Write;

pub struct LspProcess {
    /// The writer half — JSON-RPC messages from the editor go
    /// here. Held open for the lifetime of the LSP process.
    pub writer: Box<dyn Write + Send>,
    /// A closure that kills the underlying child. The closure
    /// approach (same as `PtyState`) sidesteps the trait-object
    /// `as`-cast issue we hit during Week 2.
    pub killer: Box<dyn FnMut() + Send + Sync>,
}

#[derive(Default)]
pub struct LspState {
    pub processes: std::sync::Mutex<HashMap<String, LspProcess>>,
}
