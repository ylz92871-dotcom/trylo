//! A document `WebView` must not inherit the host's filesystem/IPC protocols.
//! Start blank, remove Wry's per-view protocol filters, then navigate. Do not
//! replace responses after handlers run: an async asset handler could overwrite
//! the denial or read an arbitrarily large file before CORS rejects its body.

#[cfg(windows)]
fn filter(scheme: &str) -> String { format!("http://{scheme}.*") }

pub(super) fn detach(webview: &tauri::Webview) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::{CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        }};
        use windows_core::Interface;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        webview.with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                // Match the HTTP filters registered by the locked Wry 0.55.1.
                // The builder explicitly uses use_https_scheme(false).
                let page = unsafe { platform.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
                let modern = page.cast::<ICoreWebView2_22>().ok();
                for scheme in ["asset", "ipc", "tauri"] {
                    let pattern = filter(scheme);
                    let pattern = CoTaskMemPWSTR::from(pattern.as_str());
                    let pointer = *pattern.as_ref().as_pcwstr();
                    let result = unsafe {
                        if let Some(modern) = &modern {
                            // Includes iframe, dedicated/shared worker and service-worker
                            // sources, matching Wry's modern registration exactly.
                            modern.RemoveWebResourceRequestedFilterWithRequestSourceKinds(pointer, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)
                        } else { page.RemoveWebResourceRequestedFilter(pointer, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }
                    };
                    result.map_err(|e| format!("无法隔离网页的 {scheme} 协议：{e}"))?;
                }
                Ok(())
            })();
            let _ = send.send(result);
        }).map_err(|e| e.to_string())?;
        receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "网页协议隔离未就绪".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("当前原生平台尚未接入网页宿主协议隔离，请切换静态预览。".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::filter;
    #[test]
    fn removal_matches_wrys_registered_prefix_not_just_a_localhost_url() {
        // Wry 0.55.1 custom_protocol_workaround::work_around_uri_prefix is
        // "{http_or_https}://{protocol}."; webview2 appends '*'. A narrower
        // localhost filter removal succeeds without removing that registration.
        assert_eq!(filter("asset"), "http://asset.*");
        assert_eq!(filter("ipc"), "http://ipc.*");
        assert_eq!(filter("tauri"), "http://tauri.*");
    }
    #[test]
    fn upgrading_wry_requires_rechecking_the_native_protocol_contract() {
        let lock = include_str!("../../../Cargo.lock");
        let package = lock.split("[[package]]").find(|package| package.lines().any(|line| line == "name = \"wry\"")).expect("locked Wry");
        assert!(package.lines().any(|line| line == "version = \"0.55.1\""), "Revalidate Wry's filter prefix, source kinds, and per-view registration before upgrading");
    }
}
