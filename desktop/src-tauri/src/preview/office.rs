//! Owned Office conversion jobs behind a file-to-PDF boundary.
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncReadExt;

static NEXT: AtomicU64 = AtomicU64::new(0);
use super::office_engine::OfficeEngine;
use super::office_profile::ExtensionSeed;
use super::office_jobs::{OfficeJob, OfficeJobs, CANCELLED};
use std::sync::Arc;

pub struct OfficePreviewState {
    slot: tokio::sync::Semaphore,
    jobs: Arc<OfficeJobs>,
    cache_root: PathBuf,
    engine: OfficeEngine,
    extension_seed: std::sync::OnceLock<ExtensionSeed>,
}
impl Default for OfficePreviewState {
    fn default() -> Self { Self::new(std::env::temp_dir().join("trylo-office-preview")) }
}
impl OfficePreviewState {
    pub fn new(cache_root: PathBuf) -> Self {
        Self { slot: tokio::sync::Semaphore::new(1), jobs: Arc::new(OfficeJobs::default()), cache_root, engine: OfficeEngine::new(None), extension_seed: std::sync::OnceLock::new() }
    }
    pub fn bundled(cache_root: PathBuf, engine_root: PathBuf) -> Self { Self { engine: OfficeEngine::new(Some(engine_root)), ..Self::new(cache_root) } }
    pub fn cancel(&self, id: &str) -> Result<bool, String> { self.jobs.cancel(id) }
}
pub fn shutdown_office_previews(state: &OfficePreviewState) -> usize { state.jobs.shutdown() }
const MAX_INPUT: u64 = 50 * 1024 * 1024;
const MAX_OUTPUT: u64 = 100 * 1024 * 1024;

fn export_filter(ext: &str) -> Option<&'static str> {
    match ext {
        "docx" | "docm" | "dotx" | "dotm" | "doc" | "rtf" | "odt" | "ott" => {
            Some("pdf:writer_pdf_Export")
        }
        "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" | "ppt" | "odp" | "otp" => {
            Some("pdf:impress_pdf_Export")
        }
        // Preserve all cells/charts per sheet instead of silently chopping
        // a wide sheet into print-area fragments. Data view remains separate.
        "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => Some(
            "pdf:calc_pdf_Export:{\"SinglePageSheets\":{\"type\":\"boolean\",\"value\":\"true\"}}",
        ),
        _ => None,
    }
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Reuse the desktop's existing retained-handle tree terminator. The official
// Windows launcher owns a worker process; a timeout must reap both.
struct ConversionChild<'a> {
    child: std::process::Child,
    tree: crate::commands::process_termination::OwnedTreeTerminator,
    job: &'a OfficeJob,
}
impl Drop for ConversionChild<'_> {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.tree.terminate();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.job.detach();
    }
}

#[allow(clippy::too_many_lines)] // Own the profile, child, and cleanup through a single job.
async fn convert(
    target: &Path,
    converter: &Path,
    state: &OfficePreviewState,
    job: &OfficeJob,
) -> Result<Vec<u8>, String> {
    job.check()?;
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let filter = export_filter(&ext).ok_or("此格式没有页面转换器")?;
    let meta = tokio::fs::metadata(target)
        .await
        .map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_INPUT {
        return Err("页面预览支持 50 MB 以内的 Office 文件".into());
    }
    tokio::fs::create_dir_all(&state.cache_root)
        .await
        .map_err(|e| format!("创建预览缓存目录失败：{e}"))?;
    let scratch_path = state.cache_root.join(format!(
        "tp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    // create_dir refuses an existing location, including a planted link.
    tokio::fs::create_dir(&scratch_path)
        .await
        .map_err(|e| format!("创建预览临时目录失败：{e}"))?;
    let temp = Scratch(scratch_path);
    // Keep the nested Office profile short, including on Windows systems
    // whose user/cache root already contains a long package identifier.
    let profile = temp.0.join("p");
    let user = profile.join("user");
    tokio::fs::create_dir_all(&user)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(user.join("registrymodifications.xcu"), r#"<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>"#).await.map_err(|e| e.to_string())?;
    if let Some(seed) = state.extension_seed.get() {
        seed.restore(&profile).await.map_err(|e| format!("初始化页面预览配置失败：{e}"))?;
    }
    let input = temp.0.join(format!("source.{ext}"));
    // Bound the snapshot even if a producer is still appending after stat.
    let source = tokio::fs::File::open(target).await.map_err(|e| e.to_string())?;
    let mut snapshot = tokio::fs::OpenOptions::new().create_new(true).write(true).open(&input).await.map_err(|e| e.to_string())?;
    let copied = tokio::io::copy(&mut source.take(MAX_INPUT + 1), &mut snapshot).await.map_err(|e| format!("复制预览输入失败：{e}"))?;
    drop(snapshot);
    if copied > MAX_INPUT { return Err("页面预览输入在读取时超过 50 MB".into()); }
    job.check()?;
    let profile_url = tauri::Url::from_directory_path(&profile).map_err(|()| "临时目录无法创建")?;
    let diagnostic_path = temp.0.join("converter.log");
    let diagnostic = std::fs::File::create(&diagnostic_path).map_err(|e| e.to_string())?;
    let mut command = Command::new(converter);
    // Official administrative extraction includes redistributables in
    // System64 rather than installing them globally. Keep their DLL search
    // path local to the owned conversion process.
    if cfg!(windows) {
        if let Some(root) = converter.parent().and_then(Path::parent) {
            let runtime = root.join("System64");
            if runtime.is_dir() {
                let paths = std::iter::once(runtime).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>());
                command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
            }
        }
    }
    command.args([
        format!("-env:UserInstallation={profile_url}"),
        "--headless".into(),
        "--nologo".into(),
        "--nodefault".into(),
        "--norestore".into(),
        "--convert-to".into(),
        filter.into(),
        "--outdir".into(),
    ]);
    command
        .arg(&temp.0)
        .arg(&input)
        // Headless conversion does not need GPU probing. LibreOffice's probe
        // opens its bundled cl-test.ods and can leave a lock in the engine
        // directory, which must remain immutable after staging/installation.
        .env("SAL_DISABLE_OPENCL", "1")
        // Embedded Python must not mutate the verified distribution tree.
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .current_dir(&temp.0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(
            diagnostic.try_clone().map_err(|e| e.to_string())?,
        ))
        .stderr(std::process::Stdio::from(diagnostic));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let (child, tree) = crate::commands::process_termination::OwnedTreeTerminator::spawn(&mut command)
        .map_err(|e| format!("页面转换器无法启动：{e}"))?;
    let mut owned = ConversionChild {
        child,
        tree,
        job,
    };
    job.attach(owned.tree.clone())?;
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = owned.child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(60) {
            log_converter_diagnostic(&diagnostic_path);
            return Err("页面转换超时，请重试或使用外部应用打开".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    if !status.success() {
        log_converter_diagnostic(&diagnostic_path);
        return Err(format!("页面转换失败 ({status})，请使用外部应用打开"));
    }
    let output = temp.0.join("source.pdf");
    let output_meta = tokio::fs::metadata(&output)
        .await
        .map_err(|_| "未生成预览，文件可能已加密或不受支持")?;
    if output_meta.len() > MAX_OUTPUT {
        return Err("生成的预览超过 100 MB，请使用外部应用打开".into());
    }
    let bytes = tokio::fs::read(output).await.map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("转换器未返回有效 PDF".into());
    }
    if state.extension_seed.get().is_none() {
        if let Some(seed) = ExtensionSeed::capture(&profile).await { let _ = state.extension_seed.set(seed); }
    }
    Ok(bytes)
}

fn log_converter_diagnostic(path: &Path) {
    use std::io::Read;
    if let Ok(log) = std::fs::File::open(path) {
        let mut bytes = Vec::new();
        let _ = log.take(4096).read_to_end(&mut bytes);
        eprintln!("[preview] converter diagnostic: {}", String::from_utf8_lossy(&bytes));
    }
}

pub async fn render_office(
    file_path: String,
    allowed_root: String,
    job_id: Option<String>,
    state: &OfficePreviewState,
) -> Result<Vec<u8>, String> {
    let id = job_id.unwrap_or_else(|| format!("native-{:010}-{:020}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let job = state.jobs.begin(id)?;
    let target = crate::commands::work_host::validate_target(&file_path, &allowed_root).map_err(|e| e.to_string())?;
    job.check()?;
    let converter = tokio::select! { result = state.engine.converter() => result?, () = job.cancelled() => return Err(CANCELLED.into()) };
    let slot = tokio::select! {
        slot = state.slot.acquire() => slot.map_err(|_| "页面转换队列已关闭")?,
        () = job.cancelled() => return Err(CANCELLED.into()),
    };
    job.check()?;
    let result = tokio::select! {
        result = convert(&target, &converter, state, &job) => result,
        () = job.cancelled() => Err(CANCELLED.into()),
    };
    // Drop the conversion future (and its owned child/scratch guards) before
    // allowing the next document to enter the converter.
    drop(slot);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[ignore = "requires the verified LibreOffice arm64 staging output and Office fixture files"]
    async fn staged_darwin_engine_renders_office_formats() {
        let fixtures = PathBuf::from(std::env::var_os("TRYLO_OFFICE_TEST_FIXTURES").expect("Office fixture directory"));
        let engine = PathBuf::from(std::env::var_os("TRYLO_OFFICE_TEST_ENGINE").expect("verified Office engine"));
        let state = OfficePreviewState::bundled(fixtures.join("native-cache"), engine);
        for file in ["source.docx", "source.xlsx", "source.pptx"] {
            let pdf = render_office(fixtures.join(file).to_string_lossy().into_owned(),
                fixtures.to_string_lossy().into_owned(), None, &state).await
                .unwrap_or_else(|error| panic!("{file}: {error}"));
            assert!(pdf.starts_with(b"%PDF-"), "{file}");
        }
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn shutdown_reaps_the_owned_conversion() {
        let state = OfficePreviewState::default();
        let _slot = state.slot.acquire().await.unwrap();
        let mut command = Command::new("node");
        command
            .args(["-e", "setInterval(() => {}, 1000)"])
            .creation_flags(0x0800_0000);
        let child = command.spawn().expect("Node test process");
        let tree =
            crate::commands::process_termination::OwnedTreeTerminator::capture(&child).unwrap();
        let job = state.jobs.begin("00000000-0000-4000-8000-000000000001".into()).unwrap();
        let mut owned = ConversionChild { child, tree, job: &job };
        job.attach(owned.tree.clone()).unwrap();
        assert_eq!(shutdown_office_previews(&state), 1);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while owned.child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let exited = owned.child.try_wait().unwrap().is_some();
        drop(owned);
        assert!(exited, "owned conversion survived shutdown");
    }
    #[test]
    fn only_known_office_inputs_are_accepted() {
        assert!(export_filter("exe").is_none());
        assert!(export_filter("html").is_none());
        assert!(export_filter("pptx").is_some());
        assert!(export_filter("xlsx").unwrap().contains("SinglePageSheets"));
    }
    #[tokio::test]
    #[ignore = "requires installed LibreOffice and a real Office fixture"]
    async fn installed_converter_real_file() {
        let input = std::env::var("TRYLO_PREVIEW_FIXTURE").expect("fixture path");
        // Match production's per-user cache boundary. Office itself must
        // never need write access to the input workspace.
        let test_cache = std::env::temp_dir();
        eprintln!("[preview-test] cache root: {}", test_cache.display());
        let state = std::env::var_os("TRYLO_PREVIEW_ENGINE_ROOT").map_or_else(
            || OfficePreviewState::new(test_cache.clone()),
            |root| OfficePreviewState::bundled(test_cache.clone(), PathBuf::from(root)),
        );
        let original = std::fs::read(&input).unwrap();
        let bytes = render_office(
            input.clone(),
            Path::new(&input).parent().unwrap().to_string_lossy().into_owned(),
            None,
            &state,
        )
        .await
        .unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert_eq!(
            std::fs::read(&input).unwrap(),
            original,
            "conversion changed the source file"
        );
        let prefix = format!("tp-{}-", std::process::id());
        assert!(
            !std::fs::read_dir(&state.cache_root)
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)),
            "conversion left its scratch directory behind"
        );
        if let Ok(output) = std::env::var("TRYLO_PREVIEW_OUTPUT") {
            std::fs::write(output, bytes).unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "requires the supplied LibreOffice and a real Office fixture"]
    async fn real_conversion_cancels_and_next_document_completes() {
        let input = std::env::var("TRYLO_PREVIEW_FIXTURE").expect("fixture path");
        let root = Path::new(&input).parent().unwrap().to_string_lossy().into_owned();
        let cache = std::env::temp_dir().join(format!("trylo-office-cancel-{}", std::process::id()));
        let scratch = Scratch(cache.clone());
        let state = Arc::new(OfficePreviewState::bundled(cache, PathBuf::from(std::env::var_os("TRYLO_PREVIEW_ENGINE_ROOT").unwrap())));
        // Verification is shared and does not belong to the first document.
        let verification = state.engine.converter();
        tokio::pin!(verification);
        let first_id = "00000000-0000-4000-8000-000000000011";
        let first = render_office(input.clone(), root.clone(), Some(first_id.into()), &state);
        tokio::pin!(first);
        state.cancel(first_id).unwrap();
        assert_eq!(first.await.unwrap_err(), CANCELLED);
        verification.await.unwrap();

        let original = std::fs::read(&input).unwrap();
        let first_state = Arc::clone(&state); let first_input = input.clone(); let first_root = root.clone();
        let active_id = "00000000-0000-4000-8000-000000000012";
        let running = tokio::spawn(async move { render_office(first_input, first_root, Some(active_id.into()), &first_state).await });
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !state.jobs.is_active(active_id) && !running.is_finished() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(state.jobs.is_active(active_id), "conversion never attached its owned child");
        assert!(!state.cancel("00000000-0000-4000-8000-000000000099").unwrap());
        assert!(state.jobs.is_active(active_id), "wrong request cancelled the active conversion");
        let next_state = Arc::clone(&state); let next_input = input.clone();
        let next = tokio::spawn(async move { render_office(next_input, root, Some("00000000-0000-4000-8000-000000000013".into()), &next_state).await });
        assert!(state.cancel(active_id).unwrap());
        let cancelled = tokio::time::timeout(Duration::from_secs(8), running).await.expect("cancel did not reap promptly").unwrap();
        assert_eq!(cancelled.unwrap_err(), CANCELLED);
        assert!(!state.jobs.is_active(active_id));
        let bytes = tokio::time::timeout(Duration::from_secs(70), next).await.unwrap().unwrap().unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert_eq!(std::fs::read(&input).unwrap(), original);
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0, "cancel/reopen left scratch files");
    }
}
