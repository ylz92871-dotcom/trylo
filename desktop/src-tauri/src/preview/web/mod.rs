mod assets;
mod view;
#[cfg(target_os = "macos")]
mod darwin;
#[cfg(not(target_os = "macos"))]
mod host_protocols;
#[cfg(any(not(target_os = "macos"), test))]
mod profiles;
pub use assets::{WebAssets, WebOpenResult};
pub use view::{close, layout, WebBounds, WebPreviewState};
#[cfg(test)]
mod tests;
