use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lock {
    bundle: String,
    entry: String,
    signature_requirement: String,
    critical_files: BTreeMap<String, String>,
}

pub(super) fn verify_engine(root: &Path) -> Result<PathBuf, String> {
    let lock: Lock = serde_json::from_str(include_str!("../../../../scripts/build/shared/preview/office-engine.darwin-arm64.lock.json"))
        .map_err(|error| error.to_string())?;
    let canonical = root.canonicalize().map_err(|_| "Office 预览引擎资源缺失，请修复 Trylo 安装")?;
    let bundle = canonical.join(lock.bundle);
    if bundle.canonicalize().ok().as_ref() != Some(&bundle) {
        return Err("Office 预览引擎应用包缺失或已重定向".into());
    }
    for (relative, expected) in lock.critical_files {
        let path = bundle.join(&relative).canonicalize().map_err(|_| format!("Office 引擎文件缺失：{relative}"))?;
        if !path.starts_with(&bundle) {
            return Err("Office 引擎文件超出应用包目录".into());
        }
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash).map_err(|error| error.to_string())?;
        if format!("{:x}", hash.finalize()) != expected {
            return Err(format!("Office 引擎校验失败：{relative}"));
        }
    }
    let signature = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "-R", &lock.signature_requirement])
        .arg(&bundle)
        .output().map_err(|error| format!("无法校验 Office 引擎签名：{error}"))?;
    if !signature.status.success() {
        return Err("Office 引擎应用包签名无效，请修复 Trylo 安装".into());
    }
    Ok(bundle.join(lock.entry))
}
