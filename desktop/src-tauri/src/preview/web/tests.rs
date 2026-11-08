use super::WebAssets;
use std::path::PathBuf;
use tauri::http::{Request, Response};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("trylo-web-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir(&dir).unwrap();
        std::fs::create_dir(dir.join("site")).unwrap();
        for (name, content) in [("site/index.html", "<button>ready</button>"), ("site/app.js", "export const ready = true"), ("site/data.json", "{\"ready\":true}"), ("site/.env", "PRIVATE"), ("private.txt", "OUTSIDE")] {
            std::fs::write(dir.join(name), content).unwrap();
        }
        Self(std::fs::canonicalize(dir).unwrap())
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
const TOKEN: &str = "00000000-0000-4000-8000-000000000001";
fn request(assets: &WebAssets, path: &str, fallback: Option<&str>, accept: &str, method: &str) -> Response<Vec<u8>> {
    assets.serve(&Request::builder().uri(format!("http://trylo-preview.localhost{path}")).method(method).header("accept", accept).body(vec![]).unwrap(), fallback)
}
#[test]
fn serves_modules_root_assets_and_spa_then_revokes_the_grant() {
    let fixture = Fixture::new(); let assets = WebAssets::default();
    assets.open(TOKEN.into(), &fixture.0.join("site/index.html")).unwrap();
    let html = request(&assets, &format!("/{TOKEN}/index.html"), None, "text/html", "GET");
    assert_eq!(html.status(), 200);
    assert_eq!(html.headers()["X-Content-Type-Options"], "nosniff");
    assert!(html.headers()["Content-Security-Policy"].to_str().unwrap().contains("object-src 'none'"));
    assert_eq!(request(&assets, "/app.js", Some(TOKEN), "*/*", "GET").status(), 200);
    assert_eq!(request(&assets, "/app.js", None, "*/*", "GET").status(), 404, "root assets require an owning native WebView");
    assert_eq!(request(&assets, "/client/route", Some(TOKEN), "text/html", "GET").body(), html.body());
    assert!(request(&assets, "/data.json", Some(TOKEN), "*/*", "HEAD").body().is_empty());
    assert_eq!(request(&assets, "/data.json", Some(TOKEN), "*/*", "POST").status(), 405);
    assets.close(TOKEN);
    assert_eq!(request(&assets, &format!("/{TOKEN}/index.html"), None, "text/html", "GET").status(), 404);
}
#[test]
fn rejects_private_traversal_oversize_and_unsupported_resources() {
    let fixture = Fixture::new(); let assets = WebAssets::default();
    assets.open(TOKEN.into(), &fixture.0.join("site/index.html")).unwrap();
    for name in ["%2e%2e/private.txt", "%2eenv", "..%5cprivate.txt", "C:%5cWindows%5cwin.ini", "bad%00.json", "bad%ZZ.json"] {
        assert_eq!(request(&assets, &format!("/{TOKEN}/{name}"), None, "*/*", "GET").status(), 404, "{name}");
    }
    std::fs::write(fixture.0.join("site/file.exe"), "executable").unwrap();
    assert_eq!(request(&assets, "/file.exe", Some(TOKEN), "*/*", "GET").status(), 404);
    let file = std::fs::File::create(fixture.0.join("site/large.txt")).unwrap(); file.set_len(20 * 1024 * 1024 + 1).unwrap();
    assert_eq!(request(&assets, "/large.txt", Some(TOKEN), "*/*", "GET").status(), 404);
    assert!(!assets.warnings(TOKEN).is_empty());
    assert!(assets.open("bad".into(), &fixture.0.join("site/index.html")).is_err());
}

#[test]
fn a_known_other_grant_does_not_override_the_requesting_views_owner() {
    let fixture = Fixture::new(); let assets = WebAssets::default();
    let other = "00000000-0000-4000-8000-000000000002";
    assets.open(TOKEN.into(), &fixture.0.join("site/index.html")).unwrap();
    assets.open(other.into(), &fixture.0.join("site/index.html")).unwrap();
    assert_eq!(request(&assets, &format!("/{other}/data.json"), Some(TOKEN), "*/*", "GET").status(), 403);
    assert_eq!(request(&assets, &format!("/{TOKEN}/data.json"), Some(TOKEN), "*/*", "GET").status(), 200);
}

#[test]
fn closed_worker_and_other_webviews_cannot_borrow_the_next_documents_grant() {
    use super::{WebPreviewState, view::ActiveView};
    let fixture = Fixture::new(); let state = WebPreviewState::default();
    state.assets.open(TOKEN.into(), &fixture.0.join("site/index.html")).unwrap();
    let first_label = "browser-artifact-preview-test-1";
    let active = |label: &str| ActiveView { token: TOKEN.into(), label: label.into(), profile_root: fixture.0.clone(), profile: fixture.0.join(label) };
    *state.active.lock().unwrap() = Some(active(first_label));
    let request = Request::builder().uri(format!("http://trylo-preview.localhost/{TOKEN}/data.json")).body(vec![]).unwrap();
    assert_eq!(state.serve(&request, first_label).status(), 200);
    for label in ["main", "browser-unrelated", "browser-artifact-preview"] {
        assert_eq!(state.serve(&request, label).status(), 403, "{label}");
    }
    *state.active.lock().unwrap() = Some(active("browser-artifact-preview-test-2"));
    assert_eq!(state.serve(&request, first_label).status(), 403, "an old worker must not borrow a replacement view's owner, even with a known token");
    assert_eq!(state.serve(&request, "browser-artifact-preview-test-2").status(), 200);
    *state.active.lock().unwrap() = None;
    assert_eq!(state.serve(&request, "browser-artifact-preview-test-2").status(), 403);
}
