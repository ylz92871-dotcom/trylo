use super::*;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "trylo-runtime-sessions-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root)
            .unwrap_or_else(|error| panic!("create {}: {error}", root.display()));
        Self(std::fs::canonicalize(root).unwrap())
    }
    fn name(&self) -> &str {
        self.0.to_str().unwrap()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(self.0.starts_with(temp));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trylo-runtime-sessions-test-"));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

const FIRST: &str = r#"{"schemaVersion":1,"sessions":{"conversation":{"state":"creating","sessionId":"desktop-one","runId":"runtime-one"}}}"#;
const NEXT: &str = r#"{"schemaVersion":1,"sessions":{"conversation":{"state":"established","sessionId":"desktop-one"}}}"#;

#[cfg(windows)]
struct ExternalLockOwner(std::process::Child);

#[cfg(windows)]
impl ExternalLockOwner {
    fn spawn(root: &Workspace) -> Self {
        use std::process::{Command, Stdio};
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::runtime_sessions::tests::metadata_lock_process_fixture",
                "--ignored",
                "--test-threads=1",
            ])
            .env("TRYLO_RUNTIME_LOCK_ROOT", root.name())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut owner = Self(child);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !root.0.join("lock-ready").exists() {
            assert!(
                owner.0.try_wait().unwrap().is_none(),
                "lock owner exited before acquisition"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "lock owner did not acquire the fixture file"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        owner
    }
    fn terminate(&mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}

#[cfg(windows)]
impl Drop for ExternalLockOwner {
    fn drop(&mut self) {
        // Always reap this exact owned fixture, including assertion failures.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(windows)]
#[test]
#[ignore = "helper process for independent Desktop lock ownership"]
fn metadata_lock_process_fixture() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = PathBuf::from(std::env::var_os("TRYLO_RUNTIME_LOCK_ROOT").expect("fixture root"));
    let _file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join(".trylo/runtime-sessions.v1.lock"))
        .unwrap();
    std::fs::write(root.join("lock-ready"), "acquired").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
#[test]
fn another_process_blocks_writes_and_its_exit_releases_without_unlinking() {
    let root = Workspace::new();
    let other = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    let mut owner = ExternalLockOwner::spawn(&root);
    // Another workspace must not pay for this owner's lock.
    assert!(matches!(
        state.save(other.name(), None, FIRST).unwrap(),
        RuntimeSessionsWrite::Written
    ));
    let held = state.save(root.name(), Some(FIRST), NEXT);
    assert!(
        held.is_err(),
        "an independent owner held the OS lock, but save returned {held:?}"
    );
    assert!(
        matches!(held, Err(CommandError::Io { source, .. }) if source.kind() == ErrorKind::TimedOut)
    );
    assert_eq!(
        std::fs::read_to_string(root.0.join(".trylo").join(FILE_NAME)).unwrap(),
        FIRST
    );
    owner.terminate();
    assert!(root.0.join(".trylo/runtime-sessions.v1.lock").exists());
    assert!(matches!(
        state.save(root.name(), Some(FIRST), NEXT).unwrap(),
        RuntimeSessionsWrite::Written
    ));
}

#[test]
fn missing_metadata_is_read_only_and_cas_replaces_existing_bytes() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    assert_eq!(state.load(root.name()).unwrap(), None);
    assert!(!root.0.join(".trylo").exists());
    assert!(matches!(
        state.save(root.name(), None, FIRST).unwrap(),
        RuntimeSessionsWrite::Written
    ));
    assert!(matches!(
        state.save(root.name(), Some(FIRST), NEXT).unwrap(),
        RuntimeSessionsWrite::Written
    ));
    assert_eq!(state.load(root.name()).unwrap().as_deref(), Some(NEXT));
    let names: std::collections::BTreeSet<_> = std::fs::read_dir(root.0.join(".trylo"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        names,
        [
            std::ffi::OsString::from(FILE_NAME),
            std::ffi::OsString::from(LOCK_FILE_NAME)
        ]
        .into()
    );
}

#[test]
fn a_stale_writer_cannot_replace_a_newer_association() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    assert!(
        matches!(state.save(root.name(), None, NEXT).unwrap(), RuntimeSessionsWrite::Conflict { current: Some(value) } if value == FIRST)
    );
    assert_eq!(state.load(root.name()).unwrap().as_deref(), Some(FIRST));
}

#[test]
fn malformed_old_or_new_data_preserves_the_original_file() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    for invalid in [
        "{broken",
        r#"{"schemaVersion":2,"sessions":{}}"#,
        r#"{"schemaVersion":1,"sessions":{"x":{"state":"established","sessionId":"../../escape"}}}"#,
    ] {
        assert!(state.save(root.name(), Some(FIRST), invalid).is_err());
        assert_eq!(state.load(root.name()).unwrap().as_deref(), Some(FIRST));
    }
    let path = root.0.join(".trylo").join(FILE_NAME);
    std::fs::write(&path, "{corrupt").unwrap();
    assert!(state.save(root.name(), Some("{corrupt"), NEXT).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{corrupt");
}

#[test]
fn concurrent_compare_and_swap_has_exactly_one_winner() {
    let root = Workspace::new();
    let state = Arc::new(RuntimeSessionsState::default());
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut threads = Vec::new();
    for document in [FIRST, NEXT] {
        let state = Arc::clone(&state);
        let barrier = Arc::clone(&barrier);
        let name = root.name().to_owned();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            state.save(&name, None, document).unwrap()
        }));
    }
    barrier.wait();
    let winners = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|result| matches!(result, RuntimeSessionsWrite::Written))
        .count();
    assert_eq!(winners, 1);
}

#[test]
fn independent_native_owners_have_one_cas_winner() {
    for _ in 0..24 {
        let root = Workspace::new();
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|scope| {
            let spawn = |document| {
                let barrier = &barrier;
                let root = &root;
                scope.spawn(move || {
                    let state = RuntimeSessionsState::default();
                    barrier.wait();
                    state.save(root.name(), None, document).unwrap()
                })
            };
            let a = spawn(FIRST);
            let b = spawn(NEXT);
            barrier.wait();
            let outcomes = [a.join().unwrap(), b.join().unwrap()];
            assert_eq!(
                outcomes
                    .iter()
                    .filter(|value| matches!(value, RuntimeSessionsWrite::Written))
                    .count(),
                1
            );
            assert_eq!(
                outcomes
                    .iter()
                    .filter(|value| matches!(
                        value,
                        RuntimeSessionsWrite::Conflict { current: Some(_) }
                    ))
                    .count(),
                1
            );
        });
    }
}

#[test]
fn an_invalid_lock_path_cannot_replace_existing_metadata() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    let lock = root.0.join(".trylo").join(LOCK_FILE_NAME);
    std::fs::remove_file(&lock).unwrap();
    std::fs::create_dir(&lock).unwrap();
    assert!(state.save(root.name(), Some(FIRST), NEXT).is_err());
    assert_eq!(state.load(root.name()).unwrap().as_deref(), Some(FIRST));
}

#[test]
fn a_directory_cannot_be_used_as_the_metadata_file() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    std::fs::create_dir_all(root.0.join(".trylo").join(FILE_NAME)).unwrap();
    assert!(state.load(root.name()).is_err());
    assert!(state.save(root.name(), None, FIRST).is_err());
}

#[cfg(windows)]
#[test]
fn redirected_parent_cannot_escape_the_workspace() {
    let root = Workspace::new();
    let outside = Workspace::new();
    let state = RuntimeSessionsState::default();
    let parent = root.0.join(".trylo");
    // Junction creation does not require the optional Windows symlink privilege.
    // All arguments are generated owned fixture paths; output() waits for exit.
    let junction = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&parent)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(
        junction.status.success(),
        "{}",
        String::from_utf8_lossy(&junction.stderr)
    );
    assert!(state.load(root.name()).is_err());
    assert!(state.save(root.name(), None, FIRST).is_err());
    assert!(!outside.0.join(FILE_NAME).exists());
    std::fs::remove_dir(&parent).unwrap();
}

#[test]
fn readers_never_observe_missing_or_partial_bytes_during_replacement() {
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    let path = root.0.join(".trylo").join(FILE_NAME);
    let observed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let started = Arc::new(std::sync::Barrier::new(2));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    std::thread::scope(|scope| {
        scope.spawn(|| {
            started.wait();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !done.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                let json = std::fs::read_to_string(&path).unwrap();
                assert!(json == FIRST || json == NEXT);
                observed.fetch_add(1, Ordering::Relaxed);
            }
        });
        started.wait();
        // A reader may temporarily deny replacement on Windows. That refusal
        // must preserve the original; it must never create a missing window.
        for _ in 0..40 {
            let _ = atomic_write(&path, NEXT);
            let _ = atomic_write(&path, FIRST);
        }
        done.store(true, Ordering::Release);
    });
    assert!(observed.load(Ordering::Relaxed) > 0);
    atomic_write(&path, NEXT).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), NEXT);
}

#[cfg(windows)]
#[test]
fn failed_windows_replacement_preserves_the_existing_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = Workspace::new();
    let state = RuntimeSessionsState::default();
    state.save(root.name(), None, FIRST).unwrap();
    let path = root.0.join(".trylo").join(FILE_NAME);
    let blocked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(atomic_write(&path, NEXT).is_err());
    drop(blocked);
    assert_eq!(std::fs::read_to_string(path).unwrap(), FIRST);
}

#[cfg(feature = "preview-ipc-tests")]
#[test]
fn ipc_preserves_cas_bytes_and_rejects_browser_child_callers() {
    use tauri::test::{
        get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
    };
    use tauri::Manager;
    struct CallingView<'a>(&'a tauri::Webview<MockRuntime>);
    impl AsRef<tauri::Webview<MockRuntime>> for CallingView<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }
    fn invoke(
        view: &tauri::Webview<MockRuntime>,
        command: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        get_ipc_response(
            &CallingView(view),
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: body.into(),
                headers: tauri::http::HeaderMap::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }
    let root = Workspace::new();
    let app = mock_builder()
        .manage(RuntimeSessionsState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_sessions_load,
            runtime_sessions_save
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let main_view = app.get_webview("main").unwrap();
    assert_eq!(
        invoke(
            &main_view,
            "runtime_sessions_load",
            serde_json::json!({"workspaceRoot":root.name()})
        )
        .unwrap(),
        serde_json::Value::Null
    );
    let written = invoke(
        &main_view,
        "runtime_sessions_save",
        serde_json::json!({"workspaceRoot":root.name(),"expected":null,"json":FIRST}),
    )
    .unwrap();
    assert_eq!(written, serde_json::json!({"status":"written"}));
    let conflict = invoke(
        &main_view,
        "runtime_sessions_save",
        serde_json::json!({"workspaceRoot":root.name(),"expected":null,"json":NEXT}),
    )
    .unwrap();
    assert_eq!(
        conflict,
        serde_json::json!({"status":"conflict","current":FIRST})
    );
    let child = main
        .as_ref()
        .window()
        .add_child(
            tauri::WebviewBuilder::new("browser-tab", tauri::WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(320, 240),
        )
        .unwrap();
    assert!(invoke(
        &child,
        "runtime_sessions_save",
        serde_json::json!({"workspaceRoot":root.name(),"expected":FIRST,"json":NEXT})
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(root.0.join(".trylo").join(FILE_NAME)).unwrap(),
        FIRST
    );
}
