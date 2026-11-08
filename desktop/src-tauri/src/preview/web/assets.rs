use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::http::{Request, Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy { max_resource_bytes: u64, max_total_bytes: u64, max_assets: usize, csp: String, mime: HashMap<String, String> }
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(include_str!("../../../../src/preview/providers/web-policy.json")).expect("compiled web preview policy"))
}

#[derive(Clone)]
struct Session {
    root: PathBuf,
    url: String,
    entry: PathBuf,
    loaded: HashSet<PathBuf>,
    total: u64,
    warnings: Vec<String>,
}
#[derive(Default)]
pub struct WebAssets { sessions: Mutex<HashMap<String, Session>> }
#[derive(Serialize)]
pub struct WebOpenResult { pub token: String, pub url: String }

impl WebAssets {
    /// The caller supplies a canonical, project-validated HTML target. A grant
    /// covers only its folder, not the project, filesystem or application IPC.
    pub fn open(&self, token: String, target: &Path) -> Result<WebOpenResult, String> {
        if token.len() < 32 || token.len() > 64 || !token.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') { return Err("网页预览标识无效".into()); }
        if !matches!(target.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str(), "html" | "htm") { return Err("此文件不是 HTML 网页".into()); }
        let root = target.parent().ok_or("网页目录无效")?.to_path_buf();
        let name = target.file_name().and_then(|name| name.to_str()).ok_or("网页文件名无效")?;
        let mut url = tauri::Url::parse(if cfg!(windows) { "http://trylo-preview.localhost/" } else { "trylo-preview://localhost/" }).map_err(|e| e.to_string())?;
        url.path_segments_mut().map_err(|()| "网页地址无效")?.push(&token).push(name);
        let url = url.to_string();
        let mut sessions = self.sessions.lock().map_err(|_| "网页预览状态不可用")?;
        if sessions.contains_key(&token) { return Err("网页预览标识已存在".into()); }
        if sessions.len() >= 32 { return Err("打开的网页预览过多，请关闭部分文件后重试".into()); }
        sessions.insert(token.clone(), Session { root, entry: target.to_path_buf(), url: url.clone(), loaded: HashSet::new(), total: 0, warnings: vec![] });
        Ok(WebOpenResult { token, url })
    }
    pub fn url(&self, token: &str) -> Result<String, String> {
        self.sessions.lock().map_err(|_| "网页预览状态不可用")?.get(token).map(|session| session.url.clone()).ok_or_else(|| "网页预览已关闭".into())
    }
    pub fn close(&self, token: &str) { if let Ok(mut sessions) = self.sessions.lock() { sessions.remove(token); } }
    pub fn warnings(&self, token: &str) -> Vec<String> { self.sessions.lock().ok().and_then(|sessions| sessions.get(token).map(|session| session.warnings.clone())).unwrap_or_default() }
    pub fn warn(&self, token: &str, warning: String) {
        if let Ok(mut sessions) = self.sessions.lock() { if let Some(session) = sessions.get_mut(token) { if session.warnings.len() < 10 && !session.warnings.contains(&warning) { session.warnings.push(warning); } } }
    }
    pub fn serve(&self, request: &Request<Vec<u8>>, fallback_token: Option<&str>) -> Response<Vec<u8>> {
        let path = request.uri().path().trim_start_matches('/');
        let explicit = path.split_once('/').filter(|(token, _)| self.sessions.lock().is_ok_and(|sessions| sessions.contains_key(*token)));
        if explicit.is_some_and(|(token, _)| fallback_token.is_some_and(|owner| owner != token)) { return response(403, "text/plain", vec![]); }
        let Some((token, resource)) = explicit.or_else(|| fallback_token.map(|token| (token, path))) else { return response(404, "text/plain", b"Preview not found".to_vec()); };
        if request.method() != "GET" && request.method() != "HEAD" { return response(405, "text/plain", vec![]); }
        let navigation = request.headers().get("accept").and_then(|value| value.to_str().ok()).is_some_and(|value| value.contains("text/html"));
        match self.read(token, resource, navigation) {
            Ok((mime, bytes)) => response(200, mime, if request.method() == "HEAD" { vec![] } else { bytes }),
            Err(error) => { self.warn(token, format!("{resource}: {error}")); response(404, "text/plain; charset=utf-8", error.into_bytes()) }
        }
    }
    fn read(&self, token: &str, resource: &str, navigation: bool) -> Result<(&'static str, Vec<u8>), String> {
        let (root, entry) = self.sessions.lock().map_err(|_| "预览状态不可用")?.get(token).map(|session| (session.root.clone(), session.entry.clone())).ok_or("网页预览已关闭")?;
        let decoded = percent_decode(resource)?;
        let relative = Path::new(&decoded);
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) || decoded.split(['/', '\\']).any(|part| part.starts_with('.')) { return Err("资源路径超出网页文件夹".into()); }
        let target = if resource.is_empty() { entry.clone() } else {
            std::fs::canonicalize(root.join(relative)).or_else(|error| if navigation && relative.extension().is_none() { Ok(entry.clone()) } else { Err(error) }).map_err(|_| "资源不存在")?
        };
        if !target.starts_with(&root) { return Err("资源路径超出网页文件夹".into()); }
        let mime = mime_type(&target).ok_or("此资源类型不在网页预览范围内")?;
        let file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > policy().max_resource_bytes { return Err("网页资源超过 20 MB 限制".into()); }
        {
            let mut sessions = self.sessions.lock().map_err(|_| "预览状态不可用")?;
            let session = sessions.get_mut(token).ok_or("网页预览已关闭")?;
            if !session.loaded.contains(&target) {
                if session.loaded.len() >= policy().max_assets || session.total + metadata.len() > policy().max_total_bytes { return Err("网页资源超过 512 项 / 100 MB 限制".into()); }
                session.loaded.insert(target); session.total += metadata.len();
            }
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(policy().max_resource_bytes + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > policy().max_resource_bytes { return Err("网页资源读取时超过大小限制".into()); }
        Ok((mime, bytes))
    }
}

fn response(status: u16, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status).header("Content-Type", mime).header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*").header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", policy().csp.as_str()).body(bytes).expect("static HTTP response")
}
fn percent_decode(value: &str) -> Result<String, String> {
    let input = value.as_bytes(); let mut bytes = Vec::new(); let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            let pair = value.get(index + 1..index + 3).ok_or("资源地址编码无效")?;
            bytes.push(u8::from_str_radix(pair, 16).map_err(|_| "资源地址编码无效")?); index += 3;
        } else { bytes.push(input[index]); index += 1; }
    }
    let decoded = String::from_utf8(bytes).map_err(|_| "资源地址不是 UTF-8")?;
    if decoded.chars().any(char::is_control) { return Err("资源地址包含控制字符".into()); }
    Ok(decoded)
}
fn mime_type(path: &Path) -> Option<&'static str> {
    policy().mime.get(&path.extension()?.to_str()?.to_ascii_lowercase()).map(String::as_str)
}
