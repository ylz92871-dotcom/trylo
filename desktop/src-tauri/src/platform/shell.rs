// Trylo Desktop — macOS native application menu, window theme sync,
// overlay titlebar zoom, Dock attention feedback, native NSMenu context menus,
// and fullscreen state tracking. Windows/Linux builds compile matching no-op IPC
// commands so handler registration remains uniform across platforms.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItemSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    // This shared IPC field is consumed by the native Mac menu only.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub separator: Option<bool>,
}

fn parse_window_theme(theme: Option<&str>) -> Result<Option<tauri::Theme>, String> {
    let Some(raw) = theme else {
        return Ok(None);
    };

    match raw.trim().to_ascii_lowercase().as_str() {
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        "system" => Ok(None),
        "" => Err("window theme cannot be empty".to_string()),
        other => Err(format!("unsupported window theme: {other}")),
    }
}

fn normalize_badge_count(badge_count: Option<u32>) -> Option<i64> {
    badge_count.filter(|&count| count > 0).map(i64::from)
}

fn normalize_window_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("window title cannot be empty".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_context_menu_items(items: &[ContextMenuItemSpec]) -> Result<(), String> {
    if items.is_empty() {
        return Err("context menu cannot be empty".to_string());
    }
    if items.len() > 32 {
        return Err("context menu cannot exceed 32 items".to_string());
    }
    for item in items {
        if !item.separator.unwrap_or(false) && (item.id.trim().is_empty() || item.label.trim().is_empty()) {
            return Err("context menu item requires non-empty id and label".to_string());
        }
    }
    Ok(())
}

/// Synchronizes the native window appearance (`NSWindow` and `NSVisualEffectView`
/// on macOS) with the renderer's light, dark, or system preference.
///
/// # Errors
///
/// Returns an error if `theme` is not `"light"`, `"dark"`, `"system"`, or `None`,
/// or if updating the native window theme fails.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC passes `Window` and `Option<String>` by value.
pub fn set_window_theme(window: tauri::Window, theme: Option<String>) -> Result<(), String> {
    let parsed = parse_window_theme(theme.as_deref())?;

    #[cfg(target_os = "macos")]
    {
        window.set_theme(parsed).map_err(|err| err.to_string())?;
        macos::schedule_traffic_light_sync(&window);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&window, parsed);
        Ok(())
    }
}

#[cfg(any(target_os = "macos", test))]
const DEFAULT_TRAFFIC_LIGHT_SPACING: f64 = 20.0;
#[cfg(any(target_os = "macos", test))]
const MIN_TRAFFIC_LIGHT_SPACING: f64 = 14.0;
#[cfg(any(target_os = "macos", test))]
const MAX_TRAFFIC_LIGHT_SPACING: f64 = 26.0;

#[cfg(any(target_os = "macos", test))]
fn is_valid_traffic_light_spacing(spacing: f64) -> bool {
    spacing.is_finite() && (MIN_TRAFFIC_LIGHT_SPACING..=MAX_TRAFFIC_LIGHT_SPACING).contains(&spacing)
}

#[cfg(any(target_os = "macos", test))]
fn resolve_traffic_light_spacing(measured: f64, cached: Option<f64>) -> (f64, Option<f64>) {
    if let Some(spacing) = cached.filter(|&value| is_valid_traffic_light_spacing(value)) {
        return (spacing, Some(spacing));
    }
    if is_valid_traffic_light_spacing(measured) {
        return (measured, Some(measured));
    }
    (DEFAULT_TRAFFIC_LIGHT_SPACING, None)
}

#[cfg(any(target_os = "macos", test))]
fn traffic_light_button_y(
    titlebar_height: f64,
    button_height: f64,
    target_center_from_top: f64,
    is_flipped: bool,
) -> f64 {
    if is_flipped {
        target_center_from_top - (button_height * 0.5)
    } else {
        titlebar_height - target_center_from_top - (button_height * 0.5)
    }
}

/// Updates the native window title used by Mission Control, Stage Manager, and
/// the macOS Window menu.
///
/// # Errors
///
/// Returns an error if `title` is empty or the platform window rejects the update.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_native_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    let normalized = normalize_window_title(&title)?;
    #[cfg(target_os = "macos")]
    {
        macos::set_window_title_and_sync(&window, normalized)
    }

    #[cfg(not(target_os = "macos"))]
    {
        window.set_title(&normalized).map_err(|err| err.to_string())
    }
}

/// Toggles native window zoom (`maximize` / `unmaximize`) when double-clicking
/// empty macOS overlay titlebar chrome, ignoring fullscreen windows.
///
/// # Errors
///
/// Returns an error if querying or updating the window zoom state fails.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn toggle_window_zoom(window: tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.is_fullscreen().unwrap_or(false) {
            return Ok(());
        }
        let res = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        };
        res.map_err(|err| err.to_string())?;
        macos::schedule_traffic_light_sync(&window);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}

/// Updates the macOS Dock tile badge and optionally requests a single
/// informational Dock bounce when the main window is unfocused or hidden.
///
/// # Errors
///
/// Returns an error if updating the Dock badge or requesting attention fails.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_dock_attention(
    window: tauri::Window,
    badge_count: Option<u32>,
    bounce: bool,
) -> Result<(), String> {
    let badge = normalize_badge_count(badge_count);

    #[cfg(target_os = "macos")]
    {
        window.set_badge_count(badge).map_err(|err| err.to_string())?;
        if bounce {
            let focused = window.is_focused().unwrap_or(false);
            let visible = window.is_visible().unwrap_or(true);
            if !focused || !visible {
                window
                    .request_user_attention(Some(tauri::UserAttentionType::Informational))
                    .map_err(|err| err.to_string())?;
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&window, badge, bounce);
        Ok(())
    }
}

/// Opens a native macOS `NSMenu` context menu at the current pointer position
/// and resolves to the selected item's `id`, or `None` when dismissed.
///
/// # Errors
///
/// Returns an error if menu specifications are invalid or popping the menu fails.
#[tauri::command]
pub async fn show_native_context_menu(
    window: tauri::Window,
    items: Vec<ContextMenuItemSpec>,
) -> Result<Option<String>, String> {
    validate_context_menu_items(&items)?;

    #[cfg(target_os = "macos")]
    {
        macos::popup_native_context_menu(window, items).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&window, items);
        Ok(None)
    }
}

/// Reveals an existing workspace directory in Finder (`open -R`).
///
/// # Errors
///
/// Returns an error if `path` does not exist, is not a directory, or Finder fails to launch.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn reveal_workspace_directory(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("workspace directory path is invalid".to_string());
    }
    let canonical = std::fs::canonicalize(trimmed).map_err(|err| err.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("workspace path is not a directory: {trimmed}"));
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg("--")
            .arg(&canonical)
            .output()
            .map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "open -R failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = canonical;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    use tauri::menu::{
        AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
        HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };
    use tauri::{Emitter, Manager};

    use super::ContextMenuItemSpec;
    use crate::window_state::WindowStateManager;

    const MENU_ACTION_EVENT: &str = "trylo://menu-action";
    const WINDOW_FULLSCREEN_EVENT: &str = "trylo://window-fullscreen";
    // Keep AppKit traffic lights centered on the 46pt header midline (`centerY = 23pt`)
    // whenever window geometry, zoom, or appearance updates re-tile `NSThemeFrame`.
    const TRAFFIC_LIGHT_X: f64 = 16.0;
    const HEADER_HEIGHT: f64 = 46.0;
    const TRAFFIC_LIGHT_CENTER_Y: f64 = HEADER_HEIGHT * 0.5;

    pub(super) const HANDLED_MENU_IDS: &[&str] = &[
        "app.settings",
        "file.new-task",
        "file.open-folder",
        "view.command-palette",
        "view.mode-code",
        "view.mode-work",
        "view.toggle-sidebar",
        "view.toggle-right-rail",
        "view.toggle-terminal",
        "view.toggle-browser",
        "help.shortcuts",
    ];

    static LAST_MAIN_FULLSCREEN: AtomicBool = AtomicBool::new(false);
    static APPLYING_TRAFFIC_LIGHT_INSET: AtomicBool = AtomicBool::new(false);
    static TRAFFIC_LIGHT_OBSERVERS_INSTALLED: AtomicBool = AtomicBool::new(false);
    static TRAFFIC_LIGHT_SPACING_BITS: AtomicU64 = AtomicU64::new(0);
    static CONTEXT_MENU_SEQ: AtomicU64 = AtomicU64::new(1);

    struct InsetApplyGuard;

    impl InsetApplyGuard {
        fn try_enter() -> Option<Self> {
            APPLYING_TRAFFIC_LIGHT_INSET
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| Self)
        }
    }

    impl Drop for InsetApplyGuard {
        fn drop(&mut self) {
            APPLYING_TRAFFIC_LIGHT_INSET.store(false, Ordering::Release);
        }
    }

    struct PendingContextMenu {
        prefix: String,
        sender: mpsc::SyncSender<String>,
    }

    static PENDING_CONTEXT_MENU: Mutex<Option<PendingContextMenu>> = Mutex::new(None);

    enum DynamicMenuEntry {
        Action(MenuItem<tauri::Wry>),
        Separator(PredefinedMenuItem<tauri::Wry>),
    }

    impl DynamicMenuEntry {
        fn as_is_menu_item(&self) -> &dyn IsMenuItem<tauri::Wry> {
            match self {
                Self::Action(item) => item,
                Self::Separator(sep) => sep,
            }
        }
    }

    pub(crate) fn configure_builder(
        builder: tauri::Builder<tauri::Wry>,
    ) -> tauri::Builder<tauri::Wry> {
        builder
            .menu(build_menu)
            .on_menu_event(|app, event| handle_menu_event(app, &event))
    }

    pub(crate) fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
        if let Some(menu) = app.menu() {
            if let Some(window_submenu) = menu
                .get(WINDOW_SUBMENU_ID)
                .and_then(|item| item.as_submenu().cloned())
            {
                window_submenu.set_as_windows_menu_for_nsapp()?;
            }
            if let Some(help_submenu) = menu
                .get(HELP_SUBMENU_ID)
                .and_then(|item| item.as_submenu().cloned())
            {
                help_submenu.set_as_help_menu_for_nsapp()?;
            }
        }

        app.state::<WindowStateManager>().initialize(app);
        observe_system_wake(app);

        if let Some(main) = app.get_window("main") {
            apply_traffic_light_inset_sync(&main);
            schedule_traffic_light_sync(&main);
            if let Ok(fullscreen) = main.is_fullscreen() {
                LAST_MAIN_FULLSCREEN.store(fullscreen, Ordering::Release);
            }
        }

        Ok(())
    }

    fn observe_system_wake(app: &tauri::AppHandle) {
        use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};

        let app = app.clone();
        let callback = block2::RcBlock::new(move |_| {
            let _ = app.emit_to("main", "trylo-system-wake", ());
        });
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // The workspace's notification center retains the block for the
        // application lifetime. The callback only sends through Tauri.
        unsafe {
            let _observer = center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &callback,
            );
        }
    }

    pub(crate) fn restore_main_window(app: &tauri::AppHandle) {
        if let Some(main) = app.get_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
            schedule_traffic_light_sync(&main);
        }
    }

    pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
        if window.label() != "main" {
            return;
        }
        window
            .app_handle()
            .state::<WindowStateManager>()
            .handle_window_event(window, event);

        if matches!(event, tauri::WindowEvent::Resized(_)) {
            if let Ok(fullscreen) = window.is_fullscreen() {
                let previous = LAST_MAIN_FULLSCREEN.swap(fullscreen, Ordering::AcqRel);
                if previous != fullscreen {
                    let _ = window.emit_to("main", WINDOW_FULLSCREEN_EVENT, fullscreen);
                }
            }
        }

        if matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::Focused(true)
                | tauri::WindowEvent::ThemeChanged(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            apply_traffic_light_inset_sync(window);
            schedule_traffic_light_sync(window);
        }
    }

    pub(super) fn set_window_title_and_sync(
        window: &tauri::Window,
        title: String,
    ) -> Result<(), String> {
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                use objc2::{msg_send, MainThreadMarker};
                use objc2_app_kit::NSWindow;
                use objc2_foundation::NSString;

                if MainThreadMarker::new().is_none() {
                    return;
                }
                let Ok(raw_window) = target.ns_window() else {
                    return;
                };
                if raw_window.is_null() {
                    return;
                }

                // SAFETY: MainThreadMarker and non-null Tauri NSWindow pointer were verified.
                unsafe {
                    let ns_window = &*(raw_window.cast::<NSWindow>());
                    let ns_title = NSString::from_str(&title);
                    // Call NSWindow setTitle: synchronously on the main thread rather than
                    // tao's DispatchQueue::main() async hop so NSThemeFrame re-tiles in-turn.
                    ns_window.setTitle(&ns_title);
                    if target.label() == "main" {
                        let (): () = msg_send![ns_window, layoutIfNeeded];
                        install_traffic_light_observers(ns_window);
                        apply_traffic_light_inset_to_ns_window(ns_window);
                    }
                }
            })
            .map_err(|err| err.to_string())
    }

    pub(super) fn schedule_traffic_light_sync(window: &tauri::Window) {
        if window.label() != "main" {
            return;
        }
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            apply_traffic_light_inset_sync(&target);
        });
    }

    fn apply_traffic_light_inset_sync(window: &tauri::Window) {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSWindow;

        if window.label() != "main" || MainThreadMarker::new().is_none() {
            return;
        }
        let Ok(raw_window) = window.ns_window() else {
            return;
        };
        if raw_window.is_null() {
            return;
        }

        // SAFETY: MainThreadMarker and non-null Tauri main window NSWindow pointer were verified.
        unsafe {
            let ns_window = &*(raw_window.cast::<NSWindow>());
            install_traffic_light_observers(ns_window);
            apply_traffic_light_inset_to_ns_window(ns_window);
        }
    }

    type TitlebarView = objc2::rc::Retained<objc2_app_kit::NSView>;
    type TitlebarViews = (TitlebarView, TitlebarView, [TitlebarView; 3]);

    // SAFETY: Caller must guarantee execution on the macOS main thread with a valid NSWindow.
    unsafe fn titlebar_views(ns_window: &objc2_app_kit::NSWindow) -> Option<TitlebarViews> {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2_app_kit::{NSView, NSWindowButton};

        let close: Option<Retained<NSView>> =
            msg_send![ns_window, standardWindowButton: NSWindowButton::CloseButton];
        let miniaturize: Option<Retained<NSView>> =
            msg_send![ns_window, standardWindowButton: NSWindowButton::MiniaturizeButton];
        let zoom: Option<Retained<NSView>> =
            msg_send![ns_window, standardWindowButton: NSWindowButton::ZoomButton];
        let (Some(close), Some(miniaturize), Some(zoom)) = (close, miniaturize, zoom) else {
            return None;
        };
        let titlebar_view = close.superview()?;
        let titlebar_container = titlebar_view.superview()?;
        Some((titlebar_container, titlebar_view, [close, miniaturize, zoom]))
    }

    // SAFETY: Caller must guarantee execution on the macOS main thread with a valid NSWindow.
    unsafe fn install_traffic_light_observers(ns_window: &objc2_app_kit::NSWindow) {
        use std::ptr::NonNull;

        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSView, NSViewFrameDidChangeNotification};
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        if MainThreadMarker::new().is_none()
            || TRAFFIC_LIGHT_OBSERVERS_INSTALLED.load(Ordering::Acquire)
        {
            return;
        }
        let Some((titlebar_container, titlebar_view, [close, miniaturize, zoom])) =
            titlebar_views(ns_window)
        else {
            return;
        };
        if TRAFFIC_LIGHT_OBSERVERS_INSTALLED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let callback = block2::RcBlock::new(|notification: NonNull<NSNotification>| {
            if APPLYING_TRAFFIC_LIGHT_INSET.load(Ordering::Acquire)
                || MainThreadMarker::new().is_none()
            {
                return;
            }
            let Some(obj) = notification.as_ref().object() else {
                return;
            };
            let Some(view) = obj.downcast_ref::<NSView>() else {
                return;
            };
            let Some(window) = view.window() else {
                return;
            };
            apply_traffic_light_inset_to_ns_window(&window);
        });

        let center = NSNotificationCenter::defaultCenter();
        for view in [&titlebar_container, &titlebar_view, &close, &miniaturize, &zoom] {
            view.setPostsFrameChangedNotifications(true);
            let view_obj = &*(Retained::as_ptr(view).cast::<AnyObject>());
            // NSNotificationCenter retains block-based observers for the process lifetime.
            let _observer = center.addObserverForName_object_queue_usingBlock(
                Some(NSViewFrameDidChangeNotification),
                Some(view_obj),
                None,
                &callback,
            );
        }
    }

    // SAFETY: Caller must guarantee execution on the macOS main thread with a valid NSWindow.
    unsafe fn apply_traffic_light_inset_to_ns_window(ns_window: &objc2_app_kit::NSWindow) {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSWindowStyleMask;

        if MainThreadMarker::new().is_none()
            || ns_window.styleMask().contains(NSWindowStyleMask::FullScreen)
        {
            return;
        }
        let Some(_guard) = InsetApplyGuard::try_enter() else {
            return;
        };
        let Some((titlebar_container, titlebar_view, [close, miniaturize, zoom])) =
            titlebar_views(ns_window)
        else {
            return;
        };

        let mut titlebar_rect = titlebar_container.frame();
        let target_container_y = ns_window.frame().size.height - HEADER_HEIGHT;
        if (titlebar_rect.size.height - HEADER_HEIGHT).abs() >= 0.5
            || (titlebar_rect.origin.y - target_container_y).abs() >= 0.5
        {
            titlebar_rect.size.height = HEADER_HEIGHT;
            titlebar_rect.origin.y = target_container_y;
            titlebar_container.setFrame(titlebar_rect);
        }

        let container_bounds = titlebar_container.bounds();
        let current_view_frame = titlebar_view.frame();
        if (current_view_frame.size.height - container_bounds.size.height).abs() >= 0.5
            || (current_view_frame.origin.y - container_bounds.origin.y).abs() >= 0.5
        {
            titlebar_view.setFrame(container_bounds);
        }

        let close_rect = close.frame();
        let measured = miniaturize.frame().origin.x - close_rect.origin.x;
        let cached = match TRAFFIC_LIGHT_SPACING_BITS.load(Ordering::Acquire) {
            0 => None,
            bits => Some(f64::from_bits(bits)),
        };
        let (spacing, next_cached) = super::resolve_traffic_light_spacing(measured, cached);
        if cached.is_none() {
            if let Some(valid_spacing) = next_cached {
                TRAFFIC_LIGHT_SPACING_BITS.store(valid_spacing.to_bits(), Ordering::Release);
            }
        }

        let titlebar_height = titlebar_view.bounds().size.height;
        let is_flipped = titlebar_view.isFlipped();
        for (idx, button) in [close, miniaturize, zoom].into_iter().enumerate() {
            let mut rect = button.frame();
            let target_x =
                TRAFFIC_LIGHT_X + (f64::from(u8::try_from(idx).unwrap_or(0)) * spacing);
            let target_y = super::traffic_light_button_y(
                titlebar_height,
                rect.size.height,
                TRAFFIC_LIGHT_CENTER_Y,
                is_flipped,
            );
            if (rect.origin.x - target_x).abs() >= 0.5
                || (rect.origin.y - target_y).abs() >= 0.5
            {
                rect.origin.x = target_x;
                rect.origin.y = target_y;
                button.setFrameOrigin(rect.origin);
            }
        }
    }

    pub(super) async fn popup_native_context_menu(
        window: tauri::Window,
        items: Vec<ContextMenuItemSpec>,
    ) -> Result<Option<String>, String> {
        let app = window.app_handle().clone();
        let token = CONTEXT_MENU_SEQ.fetch_add(1, Ordering::AcqRel);
        let prefix = format!("ctx:{token}:");

        let (choice_tx, choice_rx) = mpsc::sync_channel::<String>(1);
        {
            let mut guard = PENDING_CONTEXT_MENU
                .lock()
                .map_err(|_| "context menu lock poisoned".to_string())?;
            *guard = Some(PendingContextMenu {
                prefix: prefix.clone(),
                sender: choice_tx,
            });
        }

        let (done_tx, done_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let app_for_menu = app.clone();
        let menu_prefix = prefix.clone();
        app.run_on_main_thread(move || {
            let outcome = (|| -> Result<(), String> {
                let mut entries = Vec::with_capacity(items.len());
                for spec in items {
                    if spec.separator.unwrap_or(false) {
                        let sep =
                            PredefinedMenuItem::separator(&app_for_menu).map_err(|err| err.to_string())?;
                        entries.push(DynamicMenuEntry::Separator(sep));
                    } else {
                        let full_id = format!("{menu_prefix}{}", spec.id);
                        let item = MenuItem::with_id(
                            &app_for_menu,
                            full_id,
                            spec.label,
                            spec.enabled.unwrap_or(true),
                            None::<&str>,
                        )
                        .map_err(|err| err.to_string())?;
                        entries.push(DynamicMenuEntry::Action(item));
                    }
                }

                let item_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = entries
                    .iter()
                    .map(DynamicMenuEntry::as_is_menu_item)
                    .collect();
                let menu = Menu::with_items(&app_for_menu, &item_refs).map_err(|err| err.to_string())?;
                window.popup_menu(&menu).map_err(|err| err.to_string())
            })();
            let _ = done_tx.send(outcome);
        })
        .map_err(|err| err.to_string())?;

        let popup_result = tauri::async_runtime::spawn_blocking(move || {
            done_rx
                .recv()
                .map_err(|_| "context menu cancelled unexpectedly".to_string())?
        })
        .await
        .map_err(|err| err.to_string())?;

        let selected = if popup_result.is_ok() {
            tauri::async_runtime::spawn_blocking(move || {
                choice_rx.recv_timeout(Duration::from_millis(30)).ok()
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        };

        if let Ok(mut guard) = PENDING_CONTEXT_MENU.lock() {
            if guard.as_ref().is_some_and(|pending| pending.prefix == prefix) {
                *guard = None;
            }
        }

        popup_result?;
        Ok(selected)
    }

    fn handle_menu_event(app: &tauri::AppHandle, event: &MenuEvent) {
        let id = event.id().as_ref();

        if id.starts_with("ctx:") {
            if let Ok(mut guard) = PENDING_CONTEXT_MENU.lock() {
                if let Some(pending) = guard.as_ref() {
                    if let Some(stripped) = id.strip_prefix(&pending.prefix) {
                        let _ = pending.sender.try_send(stripped.to_string());
                        *guard = None;
                    }
                }
            }
            return;
        }

        let mapped_id = match id {
            "help.open-settings" => "app.settings",
            other if HANDLED_MENU_IDS.contains(&other) => other,
            _ => return,
        };

        restore_main_window(app);
        let _ = app.emit_to("main", MENU_ACTION_EVENT, mapped_id);
    }

    fn build_app_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        let pkg = app.package_info();
        let config = app.config();
        let about = AboutMetadata {
            name: Some(pkg.name.clone()),
            version: Some(pkg.version.to_string()),
            copyright: config.bundle.copyright.clone(),
            ..Default::default()
        };

        Submenu::with_items(
            app,
            "Trylo",
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(about))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "app.settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )
    }

    fn build_file_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        Submenu::with_items(
            app,
            "File",
            true,
            &[
                &MenuItem::with_id(app, "file.new-task", "New Task", true, Some("CmdOrCtrl+N"))?,
                &MenuItem::with_id(
                    app,
                    "file.open-folder",
                    "Open Folder…",
                    true,
                    Some("CmdOrCtrl+O"),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ],
        )
    }

    fn build_edit_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )
    }

    fn build_view_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        Submenu::with_items(
            app,
            "View",
            true,
            &[
                &MenuItem::with_id(
                    app,
                    "view.command-palette",
                    "Command / Search…",
                    true,
                    Some("CmdOrCtrl+K"),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "view.mode-code", "Code Mode", true, Some("CmdOrCtrl+1"))?,
                &MenuItem::with_id(app, "view.mode-work", "Work Mode", true, Some("CmdOrCtrl+2"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "view.toggle-sidebar",
                    "Toggle Sidebar",
                    true,
                    Some("CmdOrCtrl+B"),
                )?,
                &MenuItem::with_id(
                    app,
                    "view.toggle-right-rail",
                    "Toggle Right Panel",
                    true,
                    Some("CmdOrCtrl+Shift+B"),
                )?,
                &MenuItem::with_id(
                    app,
                    "view.toggle-terminal",
                    "Toggle Terminal",
                    true,
                    Some("Ctrl+`"),
                )?,
                &MenuItem::with_id(
                    app,
                    "view.toggle-browser",
                    "Toggle Browser Sidebar",
                    true,
                    Some("Alt+CmdOrCtrl+B"),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::fullscreen(app, None)?,
            ],
        )
    }

    fn build_window_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        Submenu::with_id_and_items(
            app,
            WINDOW_SUBMENU_ID,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::bring_all_to_front(app, None)?,
            ],
        )
    }

    fn build_help_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
        Submenu::with_id_and_items(
            app,
            HELP_SUBMENU_ID,
            "Help",
            true,
            &[
                &MenuItem::with_id(
                    app,
                    "help.shortcuts",
                    "Command Palette & Shortcuts…",
                    true,
                    Some("CmdOrCtrl+/"),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "help.open-settings", "Open Settings…", true, None::<&str>)?,
            ],
        )
    }

    fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
        let app_submenu = build_app_submenu(app)?;
        let file_submenu = build_file_submenu(app)?;
        let edit_submenu = build_edit_submenu(app)?;
        let view_submenu = build_view_submenu(app)?;
        let window_submenu = build_window_submenu(app)?;
        let help_submenu = build_help_submenu(app)?;

        Menu::with_items(
            app,
            &[
                &app_submenu,
                &file_submenu,
                &edit_submenu,
                &view_submenu,
                &window_submenu,
                &help_submenu,
            ],
        )
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{configure_builder, on_window_event, restore_main_window, setup};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_window_themes() {
        assert_eq!(parse_window_theme(None), Ok(None));
        assert_eq!(parse_window_theme(Some("light")), Ok(Some(tauri::Theme::Light)));
        assert_eq!(parse_window_theme(Some(" DARK ")), Ok(Some(tauri::Theme::Dark)));
        assert_eq!(parse_window_theme(Some("system")), Ok(None));
    }

    #[test]
    fn rejects_invalid_window_themes() {
        assert!(parse_window_theme(Some("")).is_err());
        assert!(parse_window_theme(Some("sepia")).is_err());
    }

    #[test]
    fn normalizes_badge_counts_and_window_titles() {
        assert_eq!(normalize_badge_count(None), None);
        assert_eq!(normalize_badge_count(Some(0)), None);
        assert_eq!(normalize_badge_count(Some(3)), Some(3));

        assert_eq!(normalize_window_title("  Trylo  "), Ok("Trylo".to_string()));
        assert!(normalize_window_title("   ").is_err());
    }

    #[test]
    fn validates_context_menu_items() {
        assert!(validate_context_menu_items(&[]).is_err());
        assert!(validate_context_menu_items(&[ContextMenuItemSpec {
            id: String::new(),
            label: "Rename".to_string(),
            enabled: Some(true),
            separator: Some(false),
        }])
        .is_err());

        assert!(validate_context_menu_items(&[
            ContextMenuItemSpec {
                id: "rename".to_string(),
                label: "重命名".to_string(),
                enabled: Some(true),
                separator: Some(false),
            },
            ContextMenuItemSpec {
                id: "sep-1".to_string(),
                label: String::new(),
                enabled: None,
                separator: Some(true),
            },
        ])
        .is_ok());

        let oversized: Vec<ContextMenuItemSpec> = (0..33)
            .map(|idx| ContextMenuItemSpec {
                id: format!("item-{idx}"),
                label: format!("Item {idx}"),
                enabled: Some(true),
                separator: Some(false),
            })
            .collect();
        assert!(validate_context_menu_items(&oversized).is_err());
    }

    #[test]
    fn resolves_and_caches_traffic_light_spacing() {
        let eps = 1e-12;
        let (spacing, next_cached) = resolve_traffic_light_spacing(20.0, None);
        assert!((spacing - 20.0).abs() < eps);
        assert_eq!(next_cached, Some(20.0));

        let (spacing_18, next_cached_18) = resolve_traffic_light_spacing(18.0, None);
        assert!((spacing_18 - 18.0).abs() < eps);
        assert_eq!(next_cached_18, Some(18.0));

        for corrupted in [29.0, 11.0, -5.0, f64::NAN, f64::INFINITY] {
            let (preserved, kept) = resolve_traffic_light_spacing(corrupted, Some(18.0));
            assert!((preserved - 18.0).abs() < eps);
            assert_eq!(kept, Some(18.0));

            let (fallback, uncached) = resolve_traffic_light_spacing(corrupted, None);
            assert!((fallback - DEFAULT_TRAFFIC_LIGHT_SPACING).abs() < eps);
            assert_eq!(uncached, None);
        }

        let (recovered, recovered_cached) = resolve_traffic_light_spacing(20.0, Some(f64::NAN));
        assert!((recovered - 20.0).abs() < eps);
        assert_eq!(recovered_cached, Some(20.0));
    }

    #[test]
    fn centers_traffic_light_button_y_on_46pt_header_midline() {
        let eps = 1e-12;
        // Both non-flipped (bottom-up) and flipped (top-down) titlebars center a 16pt button at 23pt from top.
        assert!((traffic_light_button_y(46.0, 16.0, 23.0, false) - 15.0).abs() < eps);
        assert!((traffic_light_button_y(46.0, 16.0, 23.0, true) - 15.0).abs() < eps);
        // Even if AppKit reports a non-46pt container height, top-distance stays locked at 23pt.
        assert!((traffic_light_button_y(52.0, 14.0, 23.0, false) - 22.0).abs() < eps);
        assert!((traffic_light_button_y(52.0, 14.0, 23.0, true) - 16.0).abs() < eps);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn handled_menu_ids_include_phase2_macos_shortcuts() {
        assert!(macos::HANDLED_MENU_IDS.contains(&"view.mode-code"));
        assert!(macos::HANDLED_MENU_IDS.contains(&"view.mode-work"));
        assert!(macos::HANDLED_MENU_IDS.contains(&"view.toggle-terminal"));
        assert!(macos::HANDLED_MENU_IDS.contains(&"view.toggle-browser"));
        assert!(macos::HANDLED_MENU_IDS.contains(&"help.shortcuts"));
    }
}
