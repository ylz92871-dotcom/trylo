mod assets;
mod view;
mod host_protocols;
mod profiles;
pub use assets::{WebAssets, WebOpenResult};
pub use view::{close, layout, WebBounds, WebPreviewState};
#[cfg(test)]
mod tests;
