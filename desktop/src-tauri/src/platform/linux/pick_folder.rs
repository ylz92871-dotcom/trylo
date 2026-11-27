//! Replaced by the corresponding native picker during platform integration.
pub(crate) async fn pick_folder() -> Result<Option<String>, String> {
    Err("The linux folder picker has not been integrated. See docs/development/linux.md".to_owned())
}
