//! Reuse extension registration, never document configuration or history.
use std::path::{Component, Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_ENTRIES: usize = 512;
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Small process-local seed. Each conversion still receives a new private
/// profile. All paths inside the upstream registry use bootstrap variables.
pub struct ExtensionSeed {
    files: Vec<(PathBuf, Vec<u8>)>,
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    { meta.file_type().is_symlink() }
}

impl ExtensionSeed {
    // A cache miss or failed snapshot must not fail a valid document preview.
    pub async fn capture(profile: &Path) -> Option<Self> {
        Self::capture_inner(profile).await.ok()
    }

    async fn capture_inner(profile: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let root = profile.join("user/extensions");
        if is_link(&tokio::fs::symlink_metadata(&root).await?) { return Err("linked extension cache".into()); }
        let root = tokio::fs::canonicalize(root).await?;
        let lock: serde_json::Value = serde_json::from_str(include_str!("../../../scripts/build/shared/preview/office-engine.lock.json"))?;
        let expected = lock["buildId"].as_str().ok_or("missing engine identity")?;
        let mut pending = vec![root.clone()];
        let mut files = Vec::new();
        let mut entries = 0;
        let mut total = 0;
        while let Some(dir) = pending.pop() {
            let mut children = tokio::fs::read_dir(&dir).await?;
            while let Some(child) = children.next_entry().await? {
                entries += 1;
                if entries > MAX_ENTRIES { return Err("extension cache has too many entries".into()); }
                let path = child.path();
                let relative = path.strip_prefix(&root)?.to_path_buf();
                if relative.components().count() > 12 || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
                    return Err("invalid extension cache path".into());
                }
                let meta = tokio::fs::symlink_metadata(&path).await?;
                if is_link(&meta) { return Err("linked extension cache entry".into()); }
                if !tokio::fs::canonicalize(&path).await?.starts_with(&root) { return Err("extension cache escaped profile".into()); }
                if meta.is_dir() { pending.push(path); continue; }
                if !meta.is_file() || meta.len() > (MAX_BYTES - total) as u64 { return Err("extension cache exceeds budget".into()); }
                let mut bytes = Vec::new();
                tokio::fs::File::open(path).await?.take((MAX_BYTES - total + 1) as u64).read_to_end(&mut bytes).await?;
                total += bytes.len();
                if total > MAX_BYTES { return Err("extension cache grew beyond budget".into()); }
                files.push((relative, bytes));
            }
        }
        let build_id = files.iter().find(|(path, _)| path == Path::new("buildid")).ok_or("missing extension build identity")?;
        if std::str::from_utf8(&build_id.1)?.trim_end() != expected { return Err("extension engine identity changed".into()); }
        Ok(Self { files })
    }

    pub async fn restore(&self, profile: &Path) -> Result<(), String> {
        let root = profile.join("user/extensions");
        // A fresh profile must have no prior extension state at all.
        tokio::fs::create_dir(&root).await.map_err(|e| e.to_string())?;
        for (relative, bytes) in &self.files {
            let target = root.join(relative);
            tokio::fs::create_dir_all(target.parent().ok_or("extension cache parent missing")?).await.map_err(|e| e.to_string())?;
            let mut file = tokio::fs::OpenOptions::new().create_new(true).write(true).open(target).await.map_err(|e| e.to_string())?;
            file.write_all(bytes).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("trylo-office-profile-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TestDirectory { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    async fn fixture() -> TestDirectory {
        let temp = TestDirectory::new();
        let root = temp.path().join("user/extensions/bundled");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let lock: serde_json::Value = serde_json::from_str(include_str!("../../../scripts/build/shared/preview/office-engine.lock.json")).unwrap();
        tokio::fs::write(root.parent().unwrap().join("buildid"), lock["buildId"].as_str().unwrap()).await.unwrap();
        tokio::fs::write(root.join("dictionary.xcu"), b"$BUNDLED_EXTENSIONS/dictionary.xml").await.unwrap();
        temp
    }

    #[tokio::test]
    async fn fresh_profiles_keep_registration_but_never_document_history_or_security_settings() {
        let source = fixture().await;
        tokio::fs::write(source.path().join("user/registrymodifications.xcu"), b"private document history").await.unwrap();
        let seed = ExtensionSeed::capture(source.path()).await.unwrap();
        let target = TestDirectory::new();
        tokio::fs::create_dir(target.path().join("user")).await.unwrap();
        let settings = target.path().join("user/registrymodifications.xcu");
        tokio::fs::write(&settings, b"fresh macro/link policy").await.unwrap();
        seed.restore(target.path()).await.unwrap();
        assert_eq!(tokio::fs::read(settings).await.unwrap(), b"fresh macro/link policy");
        assert_eq!(tokio::fs::read(target.path().join("user/extensions/bundled/dictionary.xcu")).await.unwrap(), b"$BUNDLED_EXTENSIONS/dictionary.xml");
        assert!(seed.restore(target.path()).await.is_err(), "must not overwrite existing state");
    }

    #[tokio::test]
    async fn changed_engine_or_oversized_cache_is_a_miss() {
        let source = fixture().await;
        tokio::fs::write(source.path().join("user/extensions/buildid"), b"different version").await.unwrap();
        assert!(ExtensionSeed::capture(source.path()).await.is_none());
        let source = fixture().await;
        let large = tokio::fs::File::create(source.path().join("user/extensions/large")).await.unwrap();
        large.set_len(MAX_BYTES as u64 + 1).await.unwrap();
        assert!(ExtensionSeed::capture(source.path()).await.is_none());
    }

    #[tokio::test]
    #[ignore = "requires supplied LibreOffice and synthetic DOCX/XLSX/PPTX fixtures"]
    async fn real_documents_use_new_profiles_with_shared_registration() {
        use super::super::office::{render_office, OfficePreviewState};
        let fixture = PathBuf::from(std::env::var_os("TRYLO_PREVIEW_FIXTURE").expect("fixture path"));
        let root = fixture.parent().unwrap();
        let cache = TestDirectory::new();
        let state = OfficePreviewState::bundled(cache.path().into(), PathBuf::from(std::env::var_os("TRYLO_PREVIEW_ENGINE_ROOT").expect("engine root")));
        let output = PathBuf::from(std::env::var_os("TRYLO_PREVIEW_OUTPUT_ROOT").expect("synthetic output directory"));
        tokio::fs::create_dir_all(&output).await.unwrap();
        for (index, name) in ["report.docx", "report.docx", "workbook.xlsx", "presentation.pptx"].iter().enumerate() {
            let input = root.join(name);
            let original = tokio::fs::read(&input).await.unwrap();
            let started = std::time::Instant::now();
            let bytes = render_office(input.to_string_lossy().into_owned(), root.to_string_lossy().into_owned(), None, &state).await.unwrap();
            eprintln!("[preview-cache-timing] {}", serde_json::json!({"index":index,"fixture":name,"seconds":started.elapsed().as_secs_f64(),"bytes":bytes.len()}));
            assert!(bytes.starts_with(b"%PDF-"));
            assert_eq!(tokio::fs::read(&input).await.unwrap(), original, "source changed");
            assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0, "temporary profile survived conversion");
            tokio::fs::write(output.join(format!("{index}-{name}.pdf")), bytes).await.unwrap();
        }
    }
}
