//! Bounded, workspace-contained resource reads for static HTML/3D previews.
#[tauri::command]
pub async fn preview_head(file_path: String, allowed_root: String) -> Result<tauri::ipc::Response, String> {
    read_head_scoped(file_path, allowed_root).await.map(tauri::ipc::Response::new)
}
async fn read_head_scoped(file_path: String, allowed_root: String) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let target = crate::commands::work_host::validate_target(&file_path, &allowed_root).map_err(|e| e.to_string())?;
    let file = tokio::fs::File::open(target).await.map_err(|e| e.to_string())?;
    if !file.metadata().await.map_err(|e| e.to_string())?.is_file() { return Err("预览路径不是文件".into()); }
    let mut head = Vec::new();
    file.take(8192).read_to_end(&mut head).await.map_err(|e| e.to_string())?;
    Ok(head)
}

#[tauri::command]
pub async fn preview_media_path(file_path: String, allowed_root: String) -> Result<String, String> {
    let target = crate::commands::work_host::validate_target(&file_path, &allowed_root).map_err(|e| e.to_string())?;
    // Header detection may identify an extensionless/misnamed media file.
    // The host owns project/file permissions; decoding owns format support.
    let metadata = tokio::fs::metadata(&target).await.map_err(|e| e.to_string())?;
    if !metadata.is_file() { return Err("媒体路径不是文件".into()); }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn preview_resource(
    file_path: String,
    allowed_root: String,
) -> Result<tauri::ipc::Response, String> {
    read_scoped(file_path, allowed_root, 10 * 1024 * 1024).await
}

#[tauri::command]
pub async fn preview_text(file_path: String, allowed_root: String) -> Result<tauri::ipc::Response, String> {
    read_scoped(file_path, allowed_root, 50 * 1024 * 1024).await
}

#[tauri::command]
pub async fn preview_binary(file_path: String, allowed_root: String) -> Result<tauri::ipc::Response, String> {
    read_scoped(file_path, allowed_root, 100 * 1024 * 1024).await
}

async fn read_scoped(file_path: String, allowed_root: String, limit: u64) -> Result<tauri::ipc::Response, String> {
    use tokio::io::AsyncReadExt;
    let target = crate::commands::work_host::validate_target(&file_path, &allowed_root)
        .map_err(|e| e.to_string())?;
    let file = tokio::fs::File::open(&target).await.map_err(|e| e.to_string())?;
    let metadata = file.metadata()
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(format!("此预览支持 {} MB 以内的文件，请使用外部应用打开更大的文件", limit / (1024 * 1024)));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit { return Err("文件读取时超过预览大小限制".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!("trylo-preview-read-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            std::fs::create_dir(&root).unwrap(); Self(root)
        }
        fn root(&self) -> String { self.0.to_string_lossy().into_owned() }
        fn file(&self, name: &str) -> String { self.0.join(name).to_string_lossy().into_owned() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[tokio::test]
    async fn binary_preview_is_scoped_and_rejects_directories() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("file.pdf"), b"%PDF-test").unwrap();
        std::fs::create_dir(fixture.0.join("other")).unwrap();
        assert!(preview_binary(fixture.file("file.pdf"), fixture.root()).await.is_ok());
        assert!(preview_binary(fixture.file("file.pdf"), fixture.file("other")).await.is_err());
        assert!(preview_binary(fixture.file("other"), fixture.root()).await.is_err());
    }
    #[tokio::test]
    async fn refuses_large_binaries_before_reading_their_contents() {
        let fixture = Fixture::new();
        std::fs::File::create(fixture.0.join("huge.pdf")).unwrap().set_len(100 * 1024 * 1024 + 1).unwrap();
        let error = preview_binary(fixture.file("huge.pdf"), fixture.root()).await.err().unwrap();
        assert!(error.contains("100 MB"));
        assert!(preview_resource(fixture.file("huge.pdf"), fixture.root()).await.err().unwrap().contains("10 MB"));
    }
    #[tokio::test]
    async fn reads_only_a_bounded_header_even_for_a_large_or_extensionless_file() {
        let fixture = Fixture::new();
        std::fs::File::create(fixture.0.join("recording")).unwrap().set_len(150 * 1024 * 1024).unwrap();
        assert_eq!(read_head_scoped(fixture.file("recording"), fixture.root()).await.unwrap().len(), 8192);
        let other = Fixture::new();
        assert!(read_head_scoped(fixture.file("recording"), other.root()).await.is_err());
        assert!(preview_media_path(fixture.file("recording"), fixture.root()).await.is_ok());
    }
}
