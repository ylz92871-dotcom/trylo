// Trylo Desktop — lsp_list Tauri command. See the architecture doc
// §2.7 + §10.2.
//
// Returns the list of registered language ids. The webview
// can render this in a UI ("Languages: TypeScript, Python, C++,
// Rust, Go"). Also returns which of them are installed on
// PATH (so the UI can mark unavailable ones).

use serde::Serialize;

use crate::commands::lsp_config;

#[derive(Debug, Serialize)]
pub struct LspLanguageInfo {
    pub id: String,
    pub extensions: Vec<String>,
    pub command: String,
    pub installed: bool,
}

#[tauri::command]
pub async fn lsp_list() -> Result<Vec<LspLanguageInfo>, String> {
    Ok(lsp_config::all()
        .iter()
        .map(|c| LspLanguageInfo {
            id: c.language_id.to_string(),
            extensions: c.extensions.iter().map(|s| (*s).to_string()).collect(),
            command: c.command.to_string(),
            installed: lsp_config::is_installed(c),
        })
        .collect())
}
