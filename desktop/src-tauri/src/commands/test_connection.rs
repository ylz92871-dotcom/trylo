// Trylo Desktop — Tauri command: test_connection.
//
// v1.15: a minimal API connectivity check. Pairs with the
// "Test" button in the Settings modal. Does a raw TCP
// connect to the apiHost (host:port extracted from the URL
// string). No HTTP body — we just want to know "can the
// user's network reach the API server?".
//
// This is intentionally a TCP-only check (no reqwest, no
// HTTP parsing) so we don't pull in a new crate. The user
// verifies the apiKey works by actually sending a prompt
// through the CLI. Phase 3 will swap this for a real
// `reqwest` HEAD/GET.
//
// Field map mirrors the TryloSettings shape on the JS
// side so the host and port are derived the same way.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, serde::Deserialize)]
// Field names mirror the JS invoke payload (`api_host` / `api_key` /
// `api_format`); separating the `api` prefix would break the IPC contract.
#[allow(clippy::struct_field_names)]
pub struct TestConnectionArgs {
    /// The apiHost URL (e.g. <https://api.anthropic.com>).
    pub api_host: String,
    /// Optional apiKey — included in the response only as
    /// "key present: yes/no" so the user can confirm the
    /// field made it through to the modal save.
    pub api_key: Option<String>,
    /// "anthropic" or "openai". Determines the test path.
    /// For now both use a plain TCP connect; the apiFormat
    /// only affects the message we show.
    #[serde(default)]
    pub api_format: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct TestConnectionResult {
    /// True when the host was reached.
    pub ok: bool,
    /// "anthropic" | "openai" | "unknown"
    pub provider: String,
    /// "key present" | "no key set"
    pub key_status: String,
    /// Short human-readable message.
    pub message: String,
    /// The resolved host:port, for debugging.
    pub endpoint: String,
}

/// Extract host + port from a URL like "<https://api.anthropic.com/v1>".
/// Returns (host, port). No external deps; we just trim the
/// scheme and the path.
fn parse_host_port(url: &str) -> Result<(String, u16), String> {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| format!("URL must start with http:// or https://: {trimmed}"))?;
    // Take everything up to the next '/' or '?' or '#'.
    let host_port = after_scheme
        .split(['/', '?', '#'])
        .next()
        .ok_or_else(|| format!("No host in URL: {trimmed}"))?;
    if host_port.is_empty() {
        return Err(format!("Empty host in URL: {trimmed}"));
    }
    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        (
            h.to_string(),
            p.parse::<u16>().map_err(|_| format!("Bad port: {p}"))?,
        )
    } else {
        // Default port by scheme.
        let default_port = if trimmed.starts_with("https://") {
            443
        } else {
            80
        };
        (host_port.to_string(), default_port)
    };
    Ok((host, port))
}

#[tauri::command]
pub async fn test_connection(args: TestConnectionArgs) -> Result<TestConnectionResult, String> {
    let provider = args.api_format.unwrap_or_else(|| "unknown".to_string());
    let key_status = if args.api_key.as_deref().unwrap_or("").is_empty() {
        "no key set"
    } else {
        "key present"
    };

    let (host, port) = parse_host_port(&args.api_host)?;
    let endpoint = format!("{host}:{port}");

    // Resolve + connect with a 5s timeout. ToSocketAddrs
    // handles DNS; the connect itself uses the std lib so
    // we don't block the runtime on slow networks.
    let addresses: Vec<_> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS lookup failed for {host}: {e}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("No addresses for {endpoint}"));
    }
    let addr = addresses[0];

    let connect_result = tokio::task::spawn_blocking(move || {
        TcpStream::connect_timeout(&addr, Duration::from_secs(5))
    })
    .await
    .map_err(|e| format!("Connect task failed: {e}"))?;

    match connect_result {
        Ok(mut stream) => {
            // Best-effort: send a minimal HTTP/1.1 HEAD and
            // read a few bytes to confirm the server speaks
            // HTTP. We don't care about the body — just that
            // the connection is live and not a raw port.
            let req = format!("HEAD / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
            let _ = stream.write_all(req.as_bytes());
            let mut buf = [0u8; 256];
            let n = stream.read(&mut buf).unwrap_or(0);
            let preview = String::from_utf8_lossy(&buf[..n.min(80)]);
            Ok(TestConnectionResult {
                ok: true,
                provider,
                key_status: key_status.to_string(),
                message: format!(
                    "Reached {endpoint}. Server replied: {}",
                    preview.lines().next().unwrap_or("(no response line)")
                ),
                endpoint,
            })
        }
        Err(e) => Err(format!("TCP connect to {endpoint} failed: {e}")),
    }
}
