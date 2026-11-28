// Trylo Desktop — persisted main window geometry with multi-monitor clamping.
//
// Saves normal (non-fullscreen) window coordinates and maximized state to
// `app_config_dir()/window-state.json` on debounced move/resize events and
// flushes synchronously before window hide or application exit.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

pub const MIN_WINDOW_WIDTH: u32 = 800;
pub const MIN_WINDOW_HEIGHT: u32 = 600;
const DEBOUNCE_DELAY: Duration = Duration::from_millis(300);
const MIN_VISIBLE_OVERLAP_PX: i64 = 120;
const MIN_TITLEBAR_VISIBLE_Y_PX: i64 = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Default)]
struct WindowStateInner {
    file_path: Option<PathBuf>,
    geometry: Option<PersistedWindowGeometry>,
    fullscreen: bool,
}

#[derive(Clone, Default)]
pub struct WindowStateManager {
    inner: Arc<Mutex<WindowStateInner>>,
    revision: Arc<AtomicU64>,
}

impl WindowStateManager {
    pub fn initialize(&self, app: &AppHandle) {
        let Ok(config_dir) = app.path().app_config_dir() else {
            return;
        };
        let file_path = config_dir.join("window-state.json");
        let saved = load_geometry_from_disk(&file_path);

        if let Some(window) = app.get_window("main") {
            let monitors = collect_monitor_rects(&window);
            let fullscreen = window.is_fullscreen().unwrap_or(false);

            let restored = saved.and_then(|geom| sanitize_geometry(geom, &monitors));
            if let Some(target) = restored {
                apply_geometry_to_window(&window, target);
            }

            let initial_geometry = restored.or_else(|| capture_normal_geometry(&window));
            if let Ok(mut guard) = self.inner.lock() {
                guard.file_path = Some(file_path);
                guard.geometry = initial_geometry;
                guard.fullscreen = fullscreen;
            }
            return;
        }

        if let Ok(mut guard) = self.inner.lock() {
            guard.file_path = Some(file_path);
            guard.geometry = saved;
        }
    }

    pub fn handle_window_event(&self, window: &Window, event: &WindowEvent) {
        if window.label() != "main" {
            return;
        }
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }

        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let maximized = !fullscreen && window.is_maximized().unwrap_or(false);
        let current_bounds = if fullscreen || maximized {
            None
        } else {
            capture_normal_geometry(window)
        };

        let changed = {
            let Ok(mut guard) = self.inner.lock() else {
                return;
            };
            guard.fullscreen = fullscreen;
            if fullscreen {
                false
            } else {
                match (guard.geometry, current_bounds) {
                    (Some(mut prev), None) => {
                        if prev.maximized == maximized {
                            false
                        } else {
                            prev.maximized = maximized;
                            guard.geometry = Some(prev);
                            true
                        }
                    }
                    (prev, Some(next)) => {
                        let next_full = PersistedWindowGeometry {
                            maximized,
                            ..next
                        };
                        if prev == Some(next_full) {
                            false
                        } else {
                            guard.geometry = Some(next_full);
                            true
                        }
                    }
                    (None, None) => false,
                }
            }
        };

        if changed {
            self.schedule_persist();
        }
    }

    pub fn flush(&self) {
        let snapshot = {
            let Ok(guard) = self.inner.lock() else {
                return;
            };
            guard.file_path.clone().zip(guard.geometry)
        };

        if let Some((path, geometry)) = snapshot {
            write_geometry_to_disk(&path, geometry);
        }
    }

    fn schedule_persist(&self) {
        let ticket = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        let state = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DEBOUNCE_DELAY);
            if state.revision.load(Ordering::Acquire) == ticket {
                state.flush();
            }
        });
    }
}

fn collect_monitor_rects(window: &Window) -> Vec<MonitorRect> {
    let Ok(monitors) = window.available_monitors() else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .map(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            MonitorRect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

fn capture_normal_geometry(window: &Window) -> Option<PersistedWindowGeometry> {
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(PersistedWindowGeometry {
        x: pos.x,
        y: pos.y,
        width: size.width.max(MIN_WINDOW_WIDTH),
        height: size.height.max(MIN_WINDOW_HEIGHT),
        maximized: window.is_maximized().unwrap_or(false),
    })
}

fn apply_geometry_to_window(window: &Window, geometry: PersistedWindowGeometry) {
    let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
    let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    if geometry.maximized {
        let _ = window.maximize();
    }
}

fn load_geometry_from_disk(path: &PathBuf) -> Option<PersistedWindowGeometry> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PersistedWindowGeometry>(&raw).ok()
}

fn write_geometry_to_disk(path: &PathBuf, geometry: PersistedWindowGeometry) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(payload) = serde_json::to_string_pretty(&geometry) else {
        return;
    };
    let tmp_path = path.with_extension("json.tmp");
    if std::fs::write(&tmp_path, payload).is_ok() {
        let _ = std::fs::rename(&tmp_path, path);
    }
}

fn rects_overlap_sufficiently(win: PersistedWindowGeometry, mon: MonitorRect) -> bool {
    let wx1 = i64::from(win.x);
    let wy1 = i64::from(win.y);
    let wx2 = wx1 + i64::from(win.width);
    let wy2 = wy1 + i64::from(win.height);

    let mx1 = i64::from(mon.x);
    let my1 = i64::from(mon.y);
    let mx2 = mx1 + i64::from(mon.width);
    let my2 = my1 + i64::from(mon.height);

    let overlap_x = wx2.min(mx2) - wx1.max(mx1);
    let overlap_y = wy2.min(my2) - wy1.max(my1);
    let titlebar_top_visible = wy1 >= my1 - 16 && wy1 <= my2 - MIN_TITLEBAR_VISIBLE_Y_PX;

    overlap_x >= MIN_VISIBLE_OVERLAP_PX
        && overlap_y >= MIN_TITLEBAR_VISIBLE_Y_PX
        && titlebar_top_visible
}

/// Validate and clamp persisted bounds against active display rectangles so a
/// disconnected external display never leaves the window unreachable off-screen.
#[must_use]
pub fn sanitize_geometry(
    saved: PersistedWindowGeometry,
    monitors: &[MonitorRect],
) -> Option<PersistedWindowGeometry> {
    let primary = monitors.first().copied()?;
    let width = saved.width.max(MIN_WINDOW_WIDTH);
    let height = saved.height.max(MIN_WINDOW_HEIGHT);
    let candidate = PersistedWindowGeometry {
        width,
        height,
        ..saved
    };

    if monitors
        .iter()
        .any(|mon| rects_overlap_sufficiently(candidate, *mon))
    {
        return Some(candidate);
    }

    let clamped_w = width.min(primary.width.max(1)).max(MIN_WINDOW_WIDTH.min(primary.width.max(1)));
    let clamped_h = height.min(primary.height.max(1)).max(MIN_WINDOW_HEIGHT.min(primary.height.max(1)));
    let centered_x = primary.x + i32::try_from((primary.width.saturating_sub(clamped_w)) / 2).unwrap_or(0);
    let centered_y = primary.y + i32::try_from((primary.height.saturating_sub(clamped_h)) / 2).unwrap_or(0);

    Some(PersistedWindowGeometry {
        x: centered_x,
        y: centered_y,
        width: clamped_w,
        height: clamped_h,
        maximized: saved.maximized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: MonitorRect = MonitorRect {
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
    };

    const SECONDARY: MonitorRect = MonitorRect {
        x: 1512,
        y: 0,
        width: 2560,
        height: 1440,
    };

    #[test]
    fn preserves_valid_secondary_monitor_geometry() {
        let saved = PersistedWindowGeometry {
            x: 1800,
            y: 120,
            width: 1400,
            height: 900,
            maximized: false,
        };
        assert_eq!(sanitize_geometry(saved, &[PRIMARY, SECONDARY]), Some(saved));
    }

    #[test]
    fn clamps_below_minimum_dimensions() {
        let saved = PersistedWindowGeometry {
            x: 100,
            y: 80,
            width: 300,
            height: 200,
            maximized: true,
        };
        assert_eq!(
            sanitize_geometry(saved, &[PRIMARY]),
            Some(PersistedWindowGeometry {
                x: 100,
                y: 80,
                width: MIN_WINDOW_WIDTH,
                height: MIN_WINDOW_HEIGHT,
                maximized: true,
            })
        );
    }

    #[test]
    fn recenters_onto_primary_when_external_monitor_disconnected() {
        let saved = PersistedWindowGeometry {
            x: 1900,
            y: 200,
            width: 1280,
            height: 800,
            maximized: false,
        };
        let sanitized = sanitize_geometry(saved, &[PRIMARY]).expect("primary monitor exists");
        assert!(sanitized.x >= 0 && sanitized.x < i32::try_from(PRIMARY.width).unwrap_or(i32::MAX));
        assert!(sanitized.y >= 0 && sanitized.y < i32::try_from(PRIMARY.height).unwrap_or(i32::MAX));
        assert_eq!(sanitized.width, 1280);
        assert_eq!(sanitized.height, 800);
    }

    #[test]
    fn recenters_when_window_is_offscreen_above_menubar() {
        let saved = PersistedWindowGeometry {
            x: 200,
            y: -500,
            width: 1000,
            height: 700,
            maximized: false,
        };
        let sanitized = sanitize_geometry(saved, &[PRIMARY]).expect("primary monitor exists");
        assert!(sanitized.y >= 0);
    }

    #[test]
    fn returns_none_when_no_monitors_available() {
        let saved = PersistedWindowGeometry {
            x: 0,
            y: 0,
            width: 1000,
            height: 700,
            maximized: false,
        };
        assert_eq!(sanitize_geometry(saved, &[]), None);
    }
}
