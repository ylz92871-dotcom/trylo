use std::path::PathBuf;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod darwin;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use darwin::verify_engine;
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
use {serde::{Deserialize, Serialize}, sha2::{Digest, Sha256}, std::io::Read, std::path::{Component, Path}};

/// Verification is shared independently of any one document request. A view
/// can cancel while it runs without starting another digest job on reopening.
pub struct OfficeEngine {
    root: Option<PathBuf>,
    ready: std::sync::OnceLock<tokio::sync::watch::Receiver<Option<Result<PathBuf, String>>>>,
}
impl OfficeEngine {
    pub fn new(root: Option<PathBuf>) -> Self { Self { root, ready: std::sync::OnceLock::new() } }
    pub async fn converter(&self) -> Result<PathBuf, String> {
        let mut ready = self.ready.get_or_init(|| {
            let (sender, receiver) = tokio::sync::watch::channel(None);
            let root = self.root.clone();
            tokio::task::spawn_blocking(move || {
                let result = root.filter(|root| {
                    !(cfg!(all(debug_assertions, target_os = "macos", target_arch = "aarch64"))
                        && std::env::var_os("TRYLO_PREVIEW_ENGINE_ROOT").is_none()
                        && root.join("LibreOffice.app").symlink_metadata().is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound))
                }).map_or_else(
                    || installed_converter().ok_or_else(|| "页面预览引擎未准备，请运行 preview 引擎准备脚本".into()),
                    |root| verify_engine(&root),
                );
                let _ = sender.send(Some(result));
            });
            receiver
        }).clone();
        loop {
            if let Some(result) = { ready.borrow().clone() } { return result; }
            ready.changed().await.map_err(|_| "页面引擎校验任务未完成".to_string())?;
        }
    }
}

fn installed_converter() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) { candidates.push(PathBuf::from(root).join("LibreOffice/program/soffice.com")); }
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
    } else {
        candidates.push(PathBuf::from("/usr/bin/libreoffice"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    provider: String,
    version: String,
    #[serde(rename = "buildId")]
    build_id: String,
    entry: String,
    files: Vec<Entry>,
}
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Deserialize, Serialize)]
struct Entry { path: String, size: u64, sha256: String }

/// Packaging verifies every payload file. At first use, verify the pinned
/// executables/core library and required resources without reopening fourteen
/// thousand language/help files on the user's first document.
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn verify_engine(root: &Path) -> Result<PathBuf, String> {
    let lock: serde_json::Value = serde_json::from_str(include_str!("../../../scripts/preview/office-engine.lock.json")).map_err(|e| e.to_string())?;
    let critical = lock["criticalFiles"].as_object().ok_or("Office 引擎版本配置无效")?;
    let manifest_path = root.join("manifest.json");
    if std::fs::metadata(&manifest_path).map_err(|_| "Office 预览引擎资源缺失，请修复 Trylo 安装")?.len() > 5 * 1024 * 1024 {
        return Err("Office 引擎清单过大".into());
    }
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(&manifest_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if manifest.schema_version != 1 || manifest.provider != "libreoffice" || manifest.entry != "program/soffice.com" || manifest.files.len() > 20_000 {
        return Err("Office 引擎清单不受支持".into());
    }
    if Some(manifest.version.as_str()) != lock["version"].as_str() || Some(manifest.build_id.as_str()) != lock["buildId"].as_str() {
        return Err("Office 引擎版本与发行配置不一致".into());
    }
    let mut entries: Vec<_> = manifest.files.iter().collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let payload = serde_json::to_vec(&entries).map_err(|e| e.to_string())?;
    let identity = format!("{:x}", Sha256::digest(payload));
    if Some(identity.as_str()) != lock["distributionFilesSha256"].as_str() { return Err("Office 引擎文件清单校验失败".into()); }
    let canonical_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    let mut required = std::collections::HashSet::from(["program/soffice.com", "program/soffice.bin", "program/mergedlo.dll", "program/version.ini", "program/services.rdb", "license.txt", "LICENSE.html", "NOTICE"]);
    let mut seen = std::collections::HashSet::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    for entry in manifest.files {
        let relative = Path::new(&entry.path);
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) || !seen.insert(entry.path.clone()) {
            return Err("Office 引擎清单包含无效路径".into());
        }
        total = total.checked_add(entry.size).ok_or("Office 引擎大小溢出")?;
        if total > 2 * 1024 * 1024 * 1024 { return Err("Office 引擎超过大小限制".into()); }
        if !required.contains(entry.path.as_str()) { continue; }
        let target = std::fs::canonicalize(root.join(relative)).map_err(|_| format!("Office 引擎文件缺失：{}", entry.path))?;
        if !target.starts_with(&canonical_root) { return Err("Office 引擎文件超出资源目录".into()); }
        let mut file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() != entry.size { return Err(format!("Office 引擎文件大小异常：{}", entry.path)); }
        if let Some(expected) = critical.get(&entry.path).and_then(serde_json::Value::as_str) {
            let mut hash = Sha256::new();
            loop {
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 { break; }
                hash.update(&buffer[..count]);
            }
            let actual = format!("{:x}", hash.finalize());
            if actual != expected || actual != entry.sha256 { return Err(format!("Office 引擎校验失败：{}", entry.path)); }
        }
        required.remove(entry.path.as_str());
    }
    if !required.is_empty() { return Err("Office 引擎不完整".into()); }
    Ok(root.join(manifest.entry))
}
