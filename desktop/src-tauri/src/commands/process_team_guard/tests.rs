use super::TeamProcessGuard;
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn node() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/runtime/node/win-x64/node.exe")
}
fn hidden(program: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}
fn workspace() -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("trylo-team-job-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    root
}
fn check_workspace(root: &Path) -> PathBuf {
    let actual = std::fs::canonicalize(root).unwrap();
    assert!(actual.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
    assert!(actual
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("trylo-team-job-"));
    actual
}
fn start_tree(root: &Path) -> (OwnedChild, TeamProcessGuard) {
    let script = r"
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const root=process.argv[1];
const timer=setInterval(()=>{
  if(!fs.existsSync(path.join(root,'launch')))return;
  clearInterval(timer);
  const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});
  child.once('spawn',()=>fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({root:process.pid,child:child.pid})));
  setInterval(()=>{if(fs.existsSync(path.join(root,'exit-root')))process.exit(0)},10);
},10);
";
    let child = OwnedChild(
        hidden(&node())
            .args(["-e", script])
            .arg(root)
            .spawn()
            .unwrap(),
    );
    let guard = TeamProcessGuard::capture(&child.0).unwrap();
    // The descendant is created only after assignment, making inheritance
    // deterministic even on a busy development machine.
    std::fs::write(root.join("launch"), "ready").unwrap();
    (child, guard)
}
fn ready(root: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::read(root.join("ready.json")) {
            Ok(bytes) => {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("owned marker read failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "owned Node tree did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn process(value: &serde_json::Value) -> OwnedHandle {
    let pid = u32::try_from(value.as_u64().unwrap()).unwrap();
    // Marker belongs to the isolated, still-live helper tree. Pin the OS
    // object before allowing its owner to exit; cleanup never follows a PID.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
    assert!(!handle.is_null(), "owned process handle unavailable");
    unsafe { OwnedHandle::from_raw_handle(handle) }
}
fn observed_exit(handle: &impl AsRawHandle) -> bool {
    // Preserve the original failure while always reaping only this pinned
    // fixture object if the candidate fails to terminate it.
    let exited = unsafe { WaitForSingleObject(handle.as_raw_handle(), 3000) } == 0;
    if !exited {
        unsafe {
            TerminateProcess(handle.as_raw_handle(), 79);
            WaitForSingleObject(handle.as_raw_handle(), 3000);
        }
    }
    exited
}

#[test]
fn dropping_team_owner_stops_its_real_tree_and_preserves_an_unrelated_root() {
    stop_owned_tree(false);
}

#[test]
fn explicit_job_stop_stops_its_real_tree_and_preserves_an_unrelated_root() {
    stop_owned_tree(true);
}

#[test]
fn observed_exit_preserves_the_existing_background_process_policy() {
    let root = workspace();
    let (mut owner, guard) = start_tree(&root);
    let descendant = process(&ready(&root)["child"]);
    std::fs::write(root.join("exit-root"), "normal root exit").unwrap();
    let owner_exited = observed_exit(&owner.0);
    let status = owner.0.wait().unwrap();
    guard.release_after_exit().unwrap();
    drop(guard);
    let descendant_live = unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) } == 258;
    // The detached child is an isolated fixture; close only its pinned object.
    unsafe {
        TerminateProcess(descendant.as_raw_handle(), 0);
        WaitForSingleObject(descendant.as_raw_handle(), 3000);
    }
    std::fs::remove_dir_all(check_workspace(&root)).unwrap();
    assert!(owner_exited && status.success());
    assert!(
        descendant_live,
        "normal root exit changed background server lifetime"
    );
}

fn stop_owned_tree(explicit: bool) {
    let root = workspace();
    let (mut child, guard) = start_tree(&root);
    let mut sibling = OwnedChild(
        hidden(&node())
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap(),
    );
    let child_handle = process(&ready(&root)["child"]);
    let mut retained = Some(guard);
    if explicit {
        retained.as_ref().unwrap().terminate().unwrap();
    } else {
        drop(retained.take());
    }
    let root_exited = observed_exit(&child.0);
    let child_exited = observed_exit(&child_handle);
    let sibling_live = sibling.0.try_wait().unwrap().is_none();
    child.0.wait().unwrap();
    drop(retained);
    drop(sibling);
    std::fs::remove_dir_all(check_workspace(&root)).unwrap();
    assert!(root_exited && child_exited, "owned tree survived its guard");
    assert!(sibling_live, "team ownership affected an unrelated root");
}

#[test]
fn abrupt_native_owner_exit_stops_the_real_root_and_descendant() {
    let root = workspace();
    let mut helper = OwnedChild(
        hidden(&std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::process_team_guard::tests::team_guard_abrupt_owner_helper",
                "--ignored",
                "--test-threads=1",
            ])
            .env("TRYLO_TEAM_GUARD_TEST_ROOT", &root)
            .spawn()
            .unwrap(),
    );
    let pids = ready(&root);
    let child_root = process(&pids["root"]);
    let descendant = process(&pids["child"]);
    std::fs::write(root.join("exit-owner"), "exit without destructors").unwrap();
    let helper_exited = observed_exit(&helper.0);
    let root_exited = observed_exit(&child_root);
    let child_exited = observed_exit(&descendant);
    let status = helper.0.wait().unwrap();
    std::fs::remove_dir_all(check_workspace(&root)).unwrap();
    assert!(
        helper_exited && status.success(),
        "isolated owner helper did not exit normally"
    );
    assert!(
        root_exited && child_exited,
        "tree survived abrupt Native owner exit"
    );
}

#[test]
#[ignore = "isolated child-process entry; invoked only by the parent guard test"]
fn team_guard_abrupt_owner_helper() {
    let root = check_workspace(Path::new(
        &std::env::var_os("TRYLO_TEAM_GUARD_TEST_ROOT").expect("missing isolated fixture root"),
    ));
    let (_child, _guard) = start_tree(&root);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("exit-owner").exists() {
        assert!(
            Instant::now() < deadline,
            "parent did not release its helper"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::process::exit(0); // Intentionally bypass Rust Drop; only OS ownership can clean the tree.
}
