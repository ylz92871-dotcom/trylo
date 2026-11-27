use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone)]
pub struct Executables { pub encoder: PathBuf, pub probe: PathBuf }
pub struct Engine { root: PathBuf, verified: OnceLock<Result<Executables, String>> }
impl Engine {
    pub fn new(root: PathBuf) -> Self { Self { root, verified: OnceLock::new() } }
    pub fn get(&self) -> Result<Executables, String> { self.verified.get_or_init(|| verify(&self.root)).clone() }
}
#[derive(Deserialize)]
struct Lock { files: Vec<Entry>, entries: Entries }
#[derive(Deserialize)]
struct Entry { path: String, size: u64, sha256: String }
#[derive(Deserialize)]
struct Entries { encoder: String, probe: String }
fn verify(root: &Path) -> Result<Executables, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) { return Err("当前平台尚未供给本地媒体兼容引擎".into()); }
    let lock: Lock = serde_json::from_str(include_str!("../../../../scripts/build/shared/preview/media-engine.lock.json")).map_err(|e| e.to_string())?;
    let canonical = std::fs::canonicalize(root).map_err(|_| "媒体兼容引擎缺失，请修复 Trylo 安装")?;
    let mut buffer = vec![0; 64 * 1024];
    for entry in lock.files {
        let relative = Path::new(&entry.path);
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) { return Err("媒体引擎路径无效".into()); }
        let target = std::fs::canonicalize(root.join(relative)).map_err(|_| format!("媒体引擎文件缺失：{}", entry.path))?;
        if !target.starts_with(&canonical) { return Err("媒体引擎路径超出资源目录".into()); }
        let mut file = std::fs::File::open(target).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() != entry.size { return Err(format!("媒体引擎大小异常：{}", entry.path)); }
        let mut hash = Sha256::new();
        loop { let size = file.read(&mut buffer).map_err(|e| e.to_string())?; if size == 0 { break; } hash.update(&buffer[..size]); }
        if format!("{:x}", hash.finalize()) != entry.sha256 { return Err(format!("媒体引擎校验失败：{}", entry.path)); }
    }
    Ok(Executables { encoder: canonical.join(lock.entries.encoder), probe: canonical.join(lock.entries.probe) })
}
