//! Replaced by the corresponding native picker during platform integration.
pub(crate) async fn pick_folder() -> Result<Option<String>, String> {
    Err("The macos folder picker has not been integrated. See docs/development/macos.md".to_owned())
}
